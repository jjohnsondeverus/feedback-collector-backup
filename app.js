require('dotenv').config();

console.log('App Token:', process.env.SLACK_APP_TOKEN ? 'Present' : 'Missing');
console.log('Bot Token:', process.env.SLACK_BOT_TOKEN ? 'Present' : 'Missing');
console.log('Signing Secret:', process.env.SLACK_SIGNING_SECRET ? 'Present' : 'Missing');

const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const JiraApi = require('jira-client');
const OpenAI = require('openai');

// Temporary storage for feedback data
const feedbackStorage = new Map();

// Add after the feedbackStorage Map
const previewStorage = new Map();

// Generate a unique ID
function generateId() {
  return `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Initialize Jira client
const jira = new JiraApi({
  protocol: 'https',
  host: process.env.JIRA_HOST,
  username: process.env.JIRA_USERNAME,
  password: process.env.JIRA_API_TOKEN,
  apiVersion: '2',
  strictSSL: true
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper function to fetch messages from a channel within a date range
async function getMessagesInDateRange(client, channelId, startDate, endDate) {
  try {
    // Try to join the channel first
    try {
      await client.conversations.join({ channel: channelId });
    } catch (joinError) {
      // Ignore if we're already in the channel or if it's a private channel
      if (joinError.data?.error !== 'already_in_channel' && joinError.data?.error !== 'is_private') {
        throw joinError;
      }
    }

    // Convert dates to timestamps (seconds since epoch)
    const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
    const endTimestamp = Math.floor(new Date(endDate).setHours(23, 59, 59, 999) / 1000);

    const result = await client.conversations.history({
      channel: channelId,
      oldest: startTimestamp.toString(),
      latest: endTimestamp.toString(),
      inclusive: true,
      limit: 1000
    });

    // Get user info for all messages
    const userIds = new Set(result.messages.map(msg => msg.user));
    const userInfo = {};
    
    // Batch fetch user information
    for (const userId of userIds) {
      try {
        const info = await client.users.info({ user: userId });
        userInfo[userId] = {
          name: info.user.real_name || info.user.name,
          email: info.user.profile.email
        };
      } catch (error) {
        console.warn(`Could not fetch info for user ${userId}:`, error.message);
        userInfo[userId] = { name: 'Unknown User', email: '' };
      }
    }

    // Fetch all thread replies for messages
    const messagesWithReplies = await Promise.all(
      result.messages.map(async (message) => {
        if (message.thread_ts) {
          const replies = await client.conversations.replies({
            channel: channelId,
            ts: message.thread_ts,
            oldest: startTimestamp.toString(),
            latest: endTimestamp.toString()
          });
          return replies.messages.map(msg => ({
            ...msg,
            user_info: userInfo[msg.user]
          }));
        }
        return [{
          ...message,
          user_info: userInfo[message.user]
        }];
      })
    );

    return messagesWithReplies.flat();
  } catch (error) {
    console.error('Error fetching messages:', error);
    throw error;
  }
}

// Add a helper function to check if a user exists in Jira
async function checkJiraUser(email) {
  try {
    const users = await jira.searchUsers({
      username: email, // Search by email
      maxResults: 1
    });
    return users.length > 0 ? users[0] : null;
  } catch (error) {
    console.warn(`Could not verify Jira user for email ${email}:`, error.message);
    return null;
  }
}

// Update the analyzeFeedback function to include reporter info
async function analyzeFeedback(messages) {
  try {
    // Group messages by thread to maintain context
    const messagesByThread = messages.reduce((acc, msg) => {
      const threadKey = msg.thread_ts || msg.ts;
      if (!acc[threadKey]) {
        acc[threadKey] = [];
      }
      acc[threadKey].push(msg);
      return acc;
    }, {});

    // Process each thread
    const processedMessages = Object.values(messagesByThread).map(threadMsgs => {
      // Find the first message in thread (original post)
      const originalMsg = threadMsgs[0];
      return {
        text: threadMsgs.map(msg => msg.text || '').join('\n'),
        reporter: originalMsg.user_info?.name || 'Unknown User',
        reporter_email: originalMsg.user_info?.email || null
      };
    });

    const conversation = processedMessages
      .map(msg => `[${msg.reporter}]: ${msg.text}`)
      .join('\n\n');

    // Only analyze if there's actual content
    if (conversation.trim().length === 0) {
      return [];
    }

    console.log('Analyzing conversation:', conversation);
    const analysis = await analyzeConversation(conversation);
    console.log('GPT Response:', JSON.stringify(analysis));
    
    // Extract and enhance the feedback array with reporter info
    const feedbackItems = (analysis.feedback || []).map((item, index) => ({
      ...item,
      reporter: processedMessages[index]?.reporter || 'Unknown User',
      reporter_email: processedMessages[index]?.reporter_email || null
    }));

    console.log('Parsed feedback:', JSON.stringify(feedbackItems));
    return feedbackItems;

  } catch (error) {
    console.error('Error analyzing feedback:', error);
    throw error;
  }
}

// Modify the analyzeConversation function to better handle scattered discussions
async function analyzeConversation(conversation) {
  const prompt = `Analyze this Slack conversation and identify product feedback, feature requests, bugs, and improvements. 
  Look for:
  - Bug reports and issues
  - Feature requests
  - Performance concerns
  - UI/UX feedback
  - Integration requests
  - Compliance/certification needs
  
  Even if the conversation is scattered, try to identify distinct items that need attention.
  For each item found, provide:
  - A clear title
  - Summary of the issue/request
  - User impact (how it affects users)
  - Current behavior (what's happening now)
  - Expected behavior (what should happen)
  - Additional context
  - Type (bug, improvement, feature, etc.)
  - Priority (high, medium, low based on user impact and urgency)

  Format as JSON with this exact structure:
  {
    "feedback": [
      {
        "title": "...",
        "summary": "...",
        "user_impact": "...",
        "current_behavior": "...",
        "expected_behavior": "...",
        "additional_context": "...",
        "type": "...",
        "priority": "..."
      }
    ]
  }`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "system",
          content: "You are a product manager analyzing Slack conversations to identify actionable feedback items."
        },
        {
          role: "user",
          content: `${prompt}\n\nConversation:\n${conversation}`
        }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const parsedResponse = JSON.parse(response.choices[0].message.content);
    return parsedResponse;
  } catch (error) {
    console.error('Error analyzing conversation:', error);
    throw error;
  }
}

// Helper functions for Jira ticket creation
function determineComponent(summary) {
  const summary_lower = summary.toLowerCase();
  if (summary_lower.includes('ui') || summary_lower.includes('interface') || summary_lower.includes('display')) {
    return 'UI/UX';
  } else if (summary_lower.includes('performance') || summary_lower.includes('speed') || summary_lower.includes('slow')) {
    return 'Performance';
  } else if (summary_lower.includes('bug') || summary_lower.includes('error') || summary_lower.includes('issue')) {
    return 'Bugs';
  } else {
    return 'General';
  }
}

function extractUserImpact(summary) {
  return summary.split('\n')[0]; // First line as impact
}

function extractCurrentBehavior(summary) {
  const lines = summary.split('\n');
  return lines.length > 1 ? lines[1] : 'Not specified';
}

function extractExpectedBehavior(summary) {
  const lines = summary.split('\n');
  return lines.length > 2 ? lines[2] : 'Not specified';
}

// Function to search for duplicate Jira issues
async function searchForDuplicates(issue) {
  try {
    const searchQuery = `project = "${issue.project}" AND summary ~ "${issue.summary}" AND created > -30d ORDER BY created DESC`;
    const results = await jira.searchJira(searchQuery);
    return results.issues || [];
  } catch (error) {
    console.error('Error searching for duplicates:', error);
    return [];
  }
}

// Update the convertToJiraFormat function
async function convertToJiraFormat(feedbackItems, projectKey) {
  // Convert each item one by one to handle async operations
  const convertedIssues = await Promise.all(feedbackItems.map(async item => {
    const issueData = {
      fields: {
        project: {
          key: projectKey
        },
        summary: item.title,
        description: `*Description:*\n${item.summary}\n\n*User Impact:*\n${item.user_impact}\n\n*Current Behavior:*\n${item.current_behavior}\n\n*Expected Behavior:*\n${item.expected_behavior}\n\n*Additional Context:*\n${item.additional_context || 'N/A'}\n\n*Reported By:*\n${item.reporter || 'Collected from Slack'}`,
        issuetype: {
          name: mapTypeToJira(item.type)
        },
        priority: {
          name: mapPriorityToJira(item.priority)
        },
        labels: ['feedback-collector']
      }
    };

    // Try to set reporter if email matches a Jira user
    if (item.reporter_email) {
      const jiraUser = await checkJiraUser(item.reporter_email);
      if (jiraUser) {
        issueData.fields.reporter = {
          name: jiraUser.name // Use Jira username instead of email
        };
      }
    }

    return issueData;
  }));

  return convertedIssues;
}

// Map our type to Jira issue types
function mapTypeToJira(type, channelType = 'general') {
  if (channelType === 'expenses') {
    // Custom mapping for expense-related items
    const expenseTypeMap = {
      'evaluation': 'Task',
      'purchase': 'Story',
      'renewal': 'Task',
      'cancellation': 'Task',
      'research': 'Story'
    };
    return expenseTypeMap[type.toLowerCase()] || 'Story';
  }

  // Existing type mapping for other channels
  const typeMap = {
    'bug': 'Bug',
    'improvement': 'Story',
    'feature': 'Story',
    'performance': 'Task',
    'UI improvement': 'Task',
    'usability': 'Story'
  };
  
  return typeMap[type.toLowerCase()] || 'Story';
}

// Map our priority to Jira priorities
function mapPriorityToJira(priority) {
  const priorityMap = {
    'low': 'Low',
    'medium': 'Medium',
    'high': 'High'
  };
  return priorityMap[priority] || 'Medium';
}

// Create Jira issues and handle responses
async function createJiraIssues(jiraIssues) {
  const results = [];
  const similarityThreshold = parseFloat(process.env.DUPLICATE_SIMILARITY_THRESHOLD || 0.5);
  
  for (const issue of jiraIssues) {
    try {
      // Clean and split the summary into keywords
      const keywords = issue.fields.summary
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 3)
        .map(word => `summary ~ "${word}"`)
        .join(' OR ');

      // Search for potential duplicates using proper JQL syntax
      const searchQuery = `project = "${issue.fields.project.key}" AND created >= -30d AND (
        summary ~ "${issue.fields.summary}" OR 
        description ~ "${issue.fields.summary}" OR 
        (${keywords})
      )`;

      const cleanQuery = searchQuery.replace(/\s+/g, ' ').trim();
      const searchResults = await jira.searchJira(cleanQuery);
      
      if (searchResults.issues && searchResults.issues.length > 0) {
        // Enhanced similarity calculation
        const similarIssue = searchResults.issues.find(existingIssue => {
          // Calculate similarity based on both summary and description
          const summaryScore = calculateSimilarity(
            existingIssue.fields.summary.toLowerCase(),
            issue.fields.summary.toLowerCase()
          );
          
          const descriptionScore = calculateSimilarity(
            existingIssue.fields.description?.toLowerCase() || '',
            issue.fields.description.toLowerCase()
          );
          
          // Weight summary more heavily than description
          const totalScore = (summaryScore * 0.7) + (descriptionScore * 0.3);
          return totalScore > similarityThreshold;
        });

        if (similarIssue) {
          results.push({
            status: 'duplicate',
            summary: issue.fields.summary,
            existingIssue: similarIssue.key,
            similarity: calculateSimilarity(
              similarIssue.fields.summary.toLowerCase(),
              issue.fields.summary.toLowerCase()
            )
          });
          continue;
        }
      }

      // Create the issue if no duplicate found
      const createdIssue = await jira.addNewIssue(issue);
      results.push({
        status: 'created',
        key: createdIssue.key,
        summary: issue.fields.summary
      });
      
    } catch (error) {
      console.error('Error creating Jira issue:', error);
      results.push({
        status: 'error',
        summary: issue.fields.summary,
        error: error.message
      });
    }
  }
  
  return results;
}

// Enhanced similarity calculation function
function calculateSimilarity(str1, str2) {
  // Convert strings to word sets
  const words1 = new Set(str1.split(/\s+/).map(w => w.toLowerCase()));
  const words2 = new Set(str2.split(/\s+/).map(w => w.toLowerCase()));
  
  // Calculate Jaccard similarity
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  // Calculate word-based similarity
  const wordSimilarity = intersection.size / union.size;
  
  // Calculate character-based similarity for handling typos
  const charSimilarity = calculateLevenshteinSimilarity(
    Array.from(words1).join(''),
    Array.from(words2).join('')
  );
  
  // Return weighted average of both similarities
  return (wordSimilarity * 0.7) + (charSimilarity * 0.3);
}

// Add Levenshtein distance for character-level similarity
function calculateLevenshteinSimilarity(str1, str2) {
  const track = Array(str2.length + 1).fill(null).map(() =>
    Array(str1.length + 1).fill(null));
  
  for(let i = 0; i <= str1.length; i++) track[0][i] = i;
  for(let j = 0; j <= str2.length; j++) track[j][0] = j;
  
  for(let j = 1; j <= str2.length; j++) {
    for(let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (track[str2.length][str1.length] / maxLength);
}

// Helper function to parse channel input
async function parseChannels(client, channelInput) {
  const channels = [];
  
  // Split by commas and clean up whitespace
  const channelNames = channelInput.split(',').map(c => c.trim());
  
  for (const name of channelNames) {
    try {
      // Handle both channel IDs and names
      let channelId = name;
      if (!name.startsWith('C')) { // If it's not already a channel ID
        const result = await client.conversations.list({
          types: 'public_channel,private_channel'
        });
        const channel = result.channels.find(c => c.name === name.replace('#', ''));
        if (channel) {
          channelId = channel.id;
        } else {
          throw new Error(`Channel "${name}" not found`);
        }
      }
      channels.push(channelId);
    } catch (error) {
      throw new Error(`Error processing channel "${name}": ${error.message}`);
    }
  }
  
  return channels;
}

// Modify the slash command to include mode selection
app.command('/collect-feedback', async ({ command, ack, client, body }) => {
  await ack();

  try {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose how you'd like to process the feedback:"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Create Jira Tickets",
              emoji: true
            },
            value: "jira",
            action_id: "mode_jira"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Generate Summary",
              emoji: true
            },
            value: "summary",
            action_id: "mode_summary"
          }
        ]
      }
    ];

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "mode_selection",
        title: {
          type: "plain_text",
          text: "Feedback Collection",
          emoji: true
        },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error:', error);
  }
});

// Add handler for summary mode
app.action('mode_summary', async ({ ack, body, client }) => {
  await ack();

  // Show channel selection modal with custom prompt for summary
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Select channels to summarize discussions from:"
      }
    },
    {
      type: "input",
      block_id: "channel_select",
      element: {
        type: "multi_channels_select",
        placeholder: {
          type: "plain_text",
          text: "Select channels",
          emoji: true
        },
        action_id: "channels_selected"
      },
      label: {
        type: "plain_text",
        text: "Channels",
        emoji: true
      }
    },
    {
      type: "input",
      block_id: "date_start",
      element: {
        type: "datepicker",
        action_id: "date_start_input",
        initial_date: new Date().toISOString().split('T')[0],
        placeholder: {
          type: "plain_text",
          text: "Select start date"
        }
      },
      label: {
        type: "plain_text",
        text: "Start Date",
        emoji: true
      }
    },
    {
      type: "input",
      block_id: "date_end",
      element: {
        type: "datepicker",
        action_id: "date_end_input",
        initial_date: new Date().toISOString().split('T')[0],
        placeholder: {
          type: "plain_text",
          text: "Select end date"
        }
      },
      label: {
        type: "plain_text",
        text: "End Date",
        emoji: true
      }
    }
  ];

  // Create the modal view object
  const modalView = {
    type: "modal",
    callback_id: "summary_channel_select",
    title: {
      type: "plain_text",
      text: "Generate Summary",
      emoji: true
    },
    blocks: blocks,
    submit: {
      type: "plain_text",
      text: "Generate",
      emoji: true
    }
  };

  // Try to update the view, fall back to opening a new one if needed
  try {
    await client.views.update({
      view_id: body.view.id,
      view: modalView
    });
  } catch (viewError) {
    if (viewError.data?.error === 'not_found') {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: modalView
      });
    } else {
      throw viewError;
    }
  }
});

// Add this handler for the edit modal submission
app.view('edit_description_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const previewId = view.private_metadata;
    const previewData = previewStorage.get(previewId);
    
    if (!previewData) {
      // Instead of throwing error, send a message to the user
      await client.chat.postEphemeral({
        channel: body.user.id,
        user: body.user.id,
        text: "Sorry, the preview data was lost. Please try starting over with your feedback submission."
      });
      return;
    }

    // Get the updated values from the modal
    const values = view.state.values;
    const updatedItem = {
      ...previewData.item,
      title: values.title.title_input.value,
      summary: values.description.description_input.value,
      user_impact: values.user_impact.user_impact_input.value,
      current_behavior: values.current_behavior.current_behavior_input.value,
      expected_behavior: values.expected_behavior.expected_behavior_input.value,
      additional_context: values.additional_context.additional_context_input.value
    };

    // Update the item in preview storage
    previewData.item = updatedItem;
    previewStorage.set(previewId, previewData);

    // Get the feedback data to rebuild the preview
    const feedbackData = feedbackStorage.get(previewData.feedbackId);
    if (!feedbackData) {
      await client.chat.postEphemeral({
        channel: body.user.id,
        user: body.user.id,
        text: "Sorry, the feedback data was lost. Please try starting over with your feedback submission."
      });
      return;
    }

    // Store all current exclusion states before rebuilding
    const exclusionStates = new Map(
      Array.from(previewStorage.entries())
        .filter(([_, data]) => data.feedbackId === previewData.feedbackId)
        .map(([_, data]) => [`${data.channelIndex}_${data.itemIndex}`, data.excluded])
    );

    // Update the item in the main feedback storage
    feedbackData.feedback.forEach(channelFeedback => {
      if (channelFeedback.channel === previewData.channelIndex) {
        channelFeedback.feedback[previewData.itemIndex] = updatedItem;
      }
    });
    feedbackStorage.set(previewData.feedbackId, feedbackData);

    // Rebuild the preview blocks
    const previewBlocks = [];
    
    for (const channelFeedback of feedbackData.feedback) {
      previewBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: `Channel: #${channelFeedback.channel}`,
          emoji: true
        }
      });

      channelFeedback.feedback.forEach((item, index) => {
        const currentPreviewId = generateId();
        const description = `*Description:*\n${item.summary}\n\n*User Impact:*\n${item.user_impact || 'Not specified'}\n\n*Current Behavior:*\n${item.current_behavior || 'Not specified'}\n\n*Expected Behavior:*\n${item.expected_behavior || 'Not specified'}\n\n*Additional Context:*\n${item.additional_context || item.summary}`;
        
        // Get the previous exclusion state
        const wasExcluded = exclusionStates.get(`${channelFeedback.channel}_${index}`) || false;
        
        previewStorage.set(currentPreviewId, {
          feedbackId: previewData.feedbackId,
          channelIndex: channelFeedback.channel,
          itemIndex: index,
          description: description,
          item: item,
          excluded: wasExcluded
        });

        previewBlocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${index + 1}. ${item.title}*\nType: ${item.type} | Priority: ${item.priority}\n\n${description}`
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✏️ Edit",
                  emoji: true
                },
                value: currentPreviewId,
                action_id: "edit_description"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: wasExcluded ? "🔄 Include" : "❌ Exclude",
                  emoji: true
                },
                value: currentPreviewId,
                action_id: "toggle_exclude",
                style: wasExcluded ? "primary" : "danger"
              }
            ]
          },
          {
            type: "divider"
          }
        );
      });
    }

    // Show preview modal
    try {
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: "modal",
          callback_id: "preview_modal",
          title: {
            type: "plain_text",
            text: "Preview Tickets",
            emoji: true
          },
          blocks: previewBlocks,
          submit: {
            type: "plain_text",
            text: "Create Tickets",
            emoji: true
          },
          close: {
            type: "plain_text",
            text: "Back",
            emoji: true
          },
          private_metadata: previewData.feedbackId
        }
      });
    } catch (viewError) {
      if (viewError.data?.error === 'not_found') {
        // If view not found, open a new modal instead
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "preview_modal",
            title: {
              type: "plain_text",
              text: "Preview Tickets",
              emoji: true
            },
            blocks: previewBlocks,
            submit: {
              type: "plain_text",
              text: "Create Tickets",
              emoji: true
            },
            close: {
              type: "plain_text",
              text: "Back",
              emoji: true
            },
            private_metadata: previewData.feedbackId
          }
        });
      } else {
        throw viewError;
      }
    }

  } catch (error) {
    console.error('Error saving changes:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error saving changes. Please try again.'
    });
  }
});

// Add handler for summary channel selection submission
app.view('summary_channel_select', async ({ ack, body, view, client }) => {
  await ack();

  try {
    const channels = view.state.values.channel_select.channels_selected.selected_channels;
    const startDate = view.state.values.date_start.date_start_input.selected_date;
    const endDate = view.state.values.date_end.date_end_input.selected_date;

    // Fetch and analyze messages from each channel
    const allFeedback = [];
    
    for (const channelId of channels) {
      try {
        const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
        const feedback = await analyzeFeedback(messages);
        
        if (feedback.length > 0) {
          allFeedback.push({
            channel: channelId,
            feedback: feedback
          });
        }
      } catch (error) {
        console.error(`Error processing channel ${channelId}:`, error);
      }
    }

    if (allFeedback.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "No feedback items were found in the selected channels and date range."
      });
      return;
    }

    // Create summary blocks
    const summaryBlocks = [];
    
    for (const channelFeedback of allFeedback) {
      // Get channel info
      const channelInfo = await client.conversations.info({ channel: channelFeedback.channel });
      const channelName = channelInfo.channel.name;

      summaryBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: `Channel: #${channelName}`,
          emoji: true
        }
      });

      channelFeedback.feedback.forEach((item, index) => {
        summaryBlocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${index + 1}. ${item.title}*\nType: ${item.type} | Priority: ${item.priority}\n\n*Description:*\n${item.summary}\n\n*User Impact:*\n${item.user_impact || 'Not specified'}\n\n*Current Behavior:*\n${item.current_behavior || 'Not specified'}\n\n*Expected Behavior:*\n${item.expected_behavior || 'Not specified'}\n\n*Additional Context:*\n${item.additional_context || 'Not specified'}\n\n*Reported By:*\n${item.reporter || 'Unknown'}`
            }
          },
          {
            type: "divider"
          }
        );
      });
    }

    // Show the summary in a new modal
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        title: {
          type: "plain_text",
          text: "Feedback Summary",
          emoji: true
        },
        blocks: summaryBlocks,
        close: {
          type: "plain_text",
          text: "Close",
          emoji: true
        }
      }
    });

  } catch (error) {
    console.error('Error generating summary:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error generating summary: ${error.message}`
    });
  }
});

// Add handler for Jira project selection submission
app.view('jira_project_select', async ({ ack, body, view, client }) => {
  await ack();

  try {
    const projectKey = view.state.values.project_key.project_key_input.value;
    const channels = view.state.values.channel_select.channels_selected.selected_channels;
    const startDate = view.state.values.date_start.date_start_input.selected_date;
    const endDate = view.state.values.date_end.date_end_input.selected_date;

    // Generate a unique feedback ID
    const feedbackId = generateId();

    // Fetch and analyze messages from each channel
    const allFeedback = [];
    
    for (const channelId of channels) {
      try {
        const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
        const feedback = await analyzeFeedback(messages);
        
        if (feedback.length > 0) {
          allFeedback.push({
            channel: channelId,
            feedback: feedback
          });
        }
      } catch (error) {
        console.error(`Error processing channel ${channelId}:`, error);
      }
    }

    if (allFeedback.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "No feedback items were found in the selected channels and date range."
      });
      return;
    }

    // Store feedback data
    feedbackStorage.set(feedbackId, {
      feedback: allFeedback,
      projectKey: projectKey
    });

    // Create preview blocks
    const previewBlocks = [];
    
    for (const channelFeedback of allFeedback) {
      // Get channel info
      const channelInfo = await client.conversations.info({ channel: channelFeedback.channel });
      const channelName = channelInfo.channel.name;

      previewBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: `Channel: #${channelName}`,
          emoji: true
        }
      });

      channelFeedback.feedback.forEach((item, index) => {
        const previewId = generateId();
        const description = `*Description:*\n${item.summary}\n\n*User Impact:*\n${item.user_impact || 'Not specified'}\n\n*Current Behavior:*\n${item.current_behavior || 'Not specified'}\n\n*Expected Behavior:*\n${item.expected_behavior || 'Not specified'}\n\n*Additional Context:*\n${item.additional_context || item.summary}`;
        
        previewStorage.set(previewId, {
          feedbackId: feedbackId,
          channelIndex: channelFeedback.channel,
          itemIndex: index,
          description: description,
          item: item,
          excluded: false
        });

        previewBlocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${index + 1}. ${item.title}*\nType: ${item.type} | Priority: ${item.priority}\n\n${description}`
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✏️ Edit",
                  emoji: true
                },
                value: previewId,
                action_id: "edit_description"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "❌ Exclude",
                  emoji: true
                },
                value: previewId,
                action_id: "toggle_exclude",
                style: "danger"
              }
            ]
          },
          {
            type: "divider"
          }
        );
      });
    }

    // Create the modal view object
    const modalView = {
      type: "modal",
      callback_id: "preview_modal",
      title: {
        type: "plain_text",
        text: "Preview Tickets",
        emoji: true
      },
      blocks: previewBlocks,
      submit: {
        type: "plain_text",
        text: "Create Tickets",
        emoji: true
      },
      close: {
        type: "plain_text",
        text: "Back",
        emoji: true
      },
      private_metadata: feedbackId
    };

    // Try to update the view, fall back to opening a new one if needed
    try {
      await client.views.update({
        view_id: body.view.id,
        view: modalView
      });
    } catch (viewError) {
      if (viewError.data?.error === 'not_found') {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: modalView
        });
      } else {
        throw viewError;
      }
    }

  } catch (error) {
    console.error('Error creating preview:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error creating preview: ${error.message}`
    });
  }
});

// Add handler for preview modal submission (creating Jira tickets)
app.view('preview_modal', async ({ ack, body, view, client }) => {
  await ack();

  try {
    const feedbackId = view.private_metadata;
    const feedbackData = feedbackStorage.get(feedbackId);
    
    if (!feedbackData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "Sorry, the feedback data was lost. Please try starting over."
      });
      return;
    }

    // Get all preview items that aren't excluded
    const includedItems = Array.from(previewStorage.entries())
      .filter(([_, data]) => data.feedbackId === feedbackId && !data.excluded)
      .map(([_, data]) => data.item);

    if (includedItems.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "No tickets to create. All items have been excluded."
      });
      return;
    }

    // Create project key selection blocks
    const projectKeyBlocks = [];
    
    for (const channelFeedback of feedbackData.feedback) {
      // Only show channels that have included items
      const hasIncludedItems = Array.from(previewStorage.entries())
        .some(([_, data]) => 
          data.feedbackId === feedbackId && 
          !data.excluded && 
          data.channelIndex === channelFeedback.channel
        );

      if (hasIncludedItems) {
        const channelInfo = await client.conversations.info({ channel: channelFeedback.channel });
        const channelName = channelInfo.channel.name;

        projectKeyBlocks.push(
          {
            type: "input",
            block_id: `project_key_${channelFeedback.channel}`,
            element: {
              type: "plain_text_input",
              action_id: "project_key_input",
              placeholder: {
                type: "plain_text",
                text: "Enter Jira project key (e.g., PROJ)",
                emoji: true
              }
            },
            label: {
              type: "plain_text",
              text: `Project Key for #${channelName}`,
              emoji: true
            }
          }
        );
      }
    }

    // Show project key selection modal
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "project_key_select",
        title: {
          type: "plain_text",
          text: "Select Project Keys",
          emoji: true
        },
        blocks: projectKeyBlocks,
        submit: {
          type: "plain_text",
          text: "Create Tickets",
          emoji: true
        },
        private_metadata: feedbackId
      }
    });

  } catch (error) {
    console.error('Error showing project key selection:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error showing project key selection: ${error.message}`
    });
  }
});

// Add handler for project key selection and final ticket creation
app.view('project_key_select', async ({ ack, body, view, client }) => {
  await ack();

  try {
    const feedbackId = view.private_metadata;
    const feedbackData = feedbackStorage.get(feedbackId);
    
    if (!feedbackData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "Sorry, the feedback data was lost. Please try starting over."
      });
      return;
    }

    // Create Jira tickets for each channel with its project key
    let allResults = [];
    
    for (const channelFeedback of feedbackData.feedback) {
      const projectKey = view.state.values[`project_key_${channelFeedback.channel}`]?.project_key_input?.value;
      
      if (projectKey) {
        // Get included items for this channel
        const channelItems = Array.from(previewStorage.entries())
          .filter(([_, data]) => 
            data.feedbackId === feedbackId && 
            !data.excluded && 
            data.channelIndex === channelFeedback.channel
          )
          .map(([_, data]) => data.item);

        if (channelItems.length > 0) {
          // Convert feedback to Jira format
          const jiraIssues = await convertToJiraFormat(channelItems, projectKey);
          
          // Create Jira tickets
          const results = await createJiraIssues(jiraIssues);
          allResults = allResults.concat(results);
        }
      }
    }

    // Send results to user
    let message = "*Jira Ticket Creation Results:*\n\n";
    
    const created = allResults.filter(r => r.status === 'created');
    const duplicates = allResults.filter(r => r.status === 'duplicate');
    const errors = allResults.filter(r => r.status === 'error');

    if (created.length > 0) {
      message += `*Created Tickets:*\n${created.map(r => `• <${process.env.JIRA_HOST}/browse/${r.key}|${r.key}> - ${r.summary}`).join('\n')}\n\n`;
    }

    if (duplicates.length > 0) {
      message += `*Potential Duplicates:*\n${duplicates.map(r => `• ${r.summary} (similar to <${process.env.JIRA_HOST}/browse/${r.existingIssue}|${r.existingIssue}>)`).join('\n')}\n\n`;
    }

    if (errors.length > 0) {
      message += `*Errors:*\n${errors.map(r => `• ${r.summary}: ${r.error}`).join('\n')}\n\n`;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: message,
      mrkdwn: true
    });

  } catch (error) {
    console.error('Error creating Jira tickets:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error creating Jira tickets: ${error.message}`
    });
  }
});

// Update the Jira mode handler to only show channel and date selection
app.action('mode_jira', async ({ ack, body, client }) => {
  await ack();

  // Show only channel selection and date range initially
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Select channels to collect feedback from:"
      }
    },
    {
      type: "input",
      block_id: "channel_select",
      element: {
        type: "multi_channels_select",
        placeholder: {
          type: "plain_text",
          text: "Select channels",
          emoji: true
        },
        action_id: "channels_selected"
      },
      label: {
        type: "plain_text",
        text: "Channels",
        emoji: true
      }
    },
    {
      type: "input",
      block_id: "date_start",
      element: {
        type: "datepicker",
        action_id: "date_start_input",
        initial_date: new Date().toISOString().split('T')[0],
        placeholder: {
          type: "plain_text",
          text: "Select start date"
        }
      },
      label: {
        type: "plain_text",
        text: "Start Date",
        emoji: true
      }
    },
    {
      type: "input",
      block_id: "date_end",
      element: {
        type: "datepicker",
        action_id: "date_end_input",
        initial_date: new Date().toISOString().split('T')[0],
        placeholder: {
          type: "plain_text",
          text: "Select end date"
        }
      },
      label: {
        type: "plain_text",
        text: "End Date",
        emoji: true
      }
    }
  ];

  // Create the modal view object
  const modalView = {
    type: "modal",
    callback_id: "feedback_collection",
    title: {
      type: "plain_text",
      text: "Collect Feedback",
      emoji: true
    },
    blocks: blocks,
    submit: {
      type: "plain_text",
      text: "Collect",
      emoji: true
    }
  };

  // Try to update the view, fall back to opening a new one if needed
  try {
    await client.views.update({
      view_id: body.view.id,
      view: modalView
    });
  } catch (viewError) {
    if (viewError.data?.error === 'not_found') {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: modalView
      });
    } else {
      throw viewError;
    }
  }
});

// Add handler for initial feedback collection
app.view('feedback_collection', async ({ ack, body, view, client }) => {
  await ack();

  try {
    const channels = view.state.values.channel_select.channels_selected.selected_channels;
    const startDate = view.state.values.date_start.date_start_input.selected_date;
    const endDate = view.state.values.date_end.date_end_input.selected_date;

    // Generate a unique feedback ID
    const feedbackId = generateId();

    // Fetch and analyze messages from each channel
    const allFeedback = [];
    
    for (const channelId of channels) {
      try {
        const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
        const feedback = await analyzeFeedback(messages);
        
        if (feedback.length > 0) {
          allFeedback.push({
            channel: channelId,
            feedback: feedback
          });
        }
      } catch (error) {
        console.error(`Error processing channel ${channelId}:`, error);
      }
    }

    if (allFeedback.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "No feedback items were found in the selected channels and date range."
      });
      return;
    }

    // Store feedback data without project key yet
    feedbackStorage.set(feedbackId, {
      feedback: allFeedback
    });

    // Create preview blocks
    const previewBlocks = [];
    
    for (const channelFeedback of allFeedback) {
      // Get channel info
      const channelInfo = await client.conversations.info({ channel: channelFeedback.channel });
      const channelName = channelInfo.channel.name;

      previewBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: `Channel: #${channelName}`,
          emoji: true
        }
      });

      channelFeedback.feedback.forEach((item, index) => {
        const previewId = generateId();
        const description = `*Description:*\n${item.summary}\n\n*User Impact:*\n${item.user_impact || 'Not specified'}\n\n*Current Behavior:*\n${item.current_behavior || 'Not specified'}\n\n*Expected Behavior:*\n${item.expected_behavior || 'Not specified'}\n\n*Additional Context:*\n${item.additional_context || item.summary}`;
        
        previewStorage.set(previewId, {
          feedbackId: feedbackId,
          channelIndex: channelFeedback.channel,
          itemIndex: index,
          description: description,
          item: item,
          excluded: false
        });

        previewBlocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${index + 1}. ${item.title}*\nType: ${item.type} | Priority: ${item.priority}\n\n${description}`
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✏️ Edit",
                  emoji: true
                },
                value: previewId,
                action_id: "edit_description"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "❌ Exclude",
                  emoji: true
                },
                value: previewId,
                action_id: "toggle_exclude",
                style: "danger"
              }
            ]
          },
          {
            type: "divider"
          }
        );
      });
    }

    // Create the modal view object
    const modalView = {
      type: "modal",
      callback_id: "preview_modal",
      title: {
        type: "plain_text",
        text: "Preview Tickets",
        emoji: true
      },
      blocks: previewBlocks,
      submit: {
        type: "plain_text",
        text: "Create Tickets",
        emoji: true
      },
      close: {
        type: "plain_text",
        text: "Back",
        emoji: true
      },
      private_metadata: feedbackId
    };

    // Try to update the view, fall back to opening a new one if needed
    try {
      await client.views.update({
        view_id: body.view.id,
        view: modalView
      });
    } catch (viewError) {
      if (viewError.data?.error === 'not_found') {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: modalView
        });
      } else {
        throw viewError;
      }
    }

  } catch (error) {
    console.error('Error creating preview:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error creating preview: ${error.message}`
    });
  }
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');
})();