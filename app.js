require('dotenv').config();

console.log('App Token:', process.env.SLACK_APP_TOKEN ? 'Present' : 'Missing');
console.log('Bot Token:', process.env.SLACK_BOT_TOKEN ? 'Present' : 'Missing');
console.log('Signing Secret:', process.env.SLACK_SIGNING_SECRET ? 'Present' : 'Missing');

const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const JiraApi = require('jira-client');
const OpenAI = require('openai');
const { FeedbackCollectionService } = require('./services/feedback-collection-service');

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

// Handle the review button click
app.action('review_feedback', async ({ ack, body, client }) => {
  try {
    await ack();
    const { sessionId } = JSON.parse(body.actions[0].value);
    const service = new FeedbackCollectionService(null, { slackClient: client });
    const preview = await service.previewFeedbackItems({ sessionId, channelId: body.channel.id });
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createPreviewModal(preview.items)
    });
  } catch (error) {
    console.error('Error showing preview:', error);
  }
});

// Handle the slash command
app.command('/collect-feedback', async ({ ack, body, client }) => {
  try {
    await ack();
    
    // Show the mode selection modal
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'feedback_mode_select',
        title: {
          type: 'plain_text',
          text: 'Feedback Collection'
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Choose how you\'d like to process the feedback:'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Create Jira Tickets'
                },
                action_id: 'create_tickets'
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Generate Summary'
                },
                action_id: 'generate_summary'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error:', error);
    await client.chat.postMessage({
      channel: body.channel_id,
      text: `❌ Error: ${error.message}`
    });
  }
});

// Handle the Create Tickets button click
app.action('create_tickets', async ({ ack, body, client }) => {
  try {
    await ack();
    
    // Show the date/channel picker modal
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'collect_feedback_modal',
        title: {
          type: 'plain_text',
          text: 'Select Channel & Dates'
        },
        blocks: [
          {
            type: 'input',
            block_id: 'channels',
            label: {
              type: 'plain_text',
              text: 'Select Channel'
            },
            element: {
              type: 'channels_select',
              action_id: 'channel_select'
            }
          },
          {
            type: 'input',
            block_id: 'startDate',
            label: {
              type: 'plain_text',
              text: 'Start Date'
            },
            element: {
              type: 'datepicker',
              action_id: 'datepicker'
            }
          },
          {
            type: 'input',
            block_id: 'endDate',
            label: {
              type: 'plain_text',
              text: 'End Date'
            },
            element: {
              type: 'datepicker',
              action_id: 'datepicker'
            }
          }
        ],
        submit: {
          type: 'plain_text',
          text: 'Collect'
        }
      }
    });
  } catch (error) {
    console.error('Error showing date picker:', error);
  }
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');
})();

async function handleFeedbackCollection(client, userId, messageTs, startDate, endDate, sessionId, targetChannel) {
  try {
    try {
      // Update progress message in user's DM
      await client.chat.update({
        channel: userId,
        ts: messageTs,
        text: "📥 Fetching messages...\n0% complete"
      });

      const messages = await getMessagesInDateRange(client, targetChannel, startDate, endDate);

      // Process messages in batches with progress updates
      const totalMessages = messages.length;
      const batchSize = 50;
      const batches = Math.ceil(totalMessages / batchSize);

      for (let i = 0; i < batches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, totalMessages);
        const batch = messages.slice(start, end);
        
        await client.chat.update({
          channel: userId,
          ts: messageTs,
          text: `🤖 Analyzing conversation...\n${Math.round((i + 1) / batches * 100)}% complete\n` +
                `Processed ${end} of ${totalMessages} messages`
        });

        const service = new FeedbackCollectionService(null, { slackClient: client });
        await service.collectFeedbackFromMessages({
          sessionId,
          channelId: targetChannel,
          messages: batch
        });
      }

      // Show completion message with review button
      await client.chat.update({
        channel: userId,
        ts: messageTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ Generated feedback items from <#${targetChannel}>. Click below to review:`
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Review Feedback Items"
                },
                action_id: "review_feedback",
                value: JSON.stringify({ sessionId })
              }
            ]
          }
        ],
        text: "Feedback collection complete" // Fallback text
      });

    } catch (error) {
      // Handle specific errors with user-friendly messages
      let errorMessage = "An error occurred during processing.\n\n";
      let suggestion = "";
      
      if (error.message.includes("rate_limited")) {
        suggestion = "• Wait a few minutes and try again\n" +
                    "• Try processing a smaller date range";
      } else if (error.message.includes("not_in_channel")) {
        suggestion = "• Invite the bot to the channel first\n" +
                    "• Verify the bot has proper channel access";
      } else {
        suggestion = "• Try with a smaller date range\n" +
                    "• Check if the channels are accessible";
      }

      await client.chat.update({
        channel: userId,
        ts: messageTs,
        text: `❌ ${errorMessage}\nError: ${error.message}\n\nTry:\n${suggestion}`
      });
    }
  } catch (error) {
    console.error('Error updating progress:', error);
    await client.chat.postMessage({
      channel: userId,
      text: "❌ Error processing feedback. Please try again."
    });
  }
}

app.view('collect_feedback_modal', async ({ ack, body, view, client }) => {
  try {
    const { channels, startDate, endDate } = view.state.values;
    const channelId = channels.channel_select.selected_channel;
    const start = startDate.datepicker.selected_date;
    const end = endDate.datepicker.selected_date;

    await ack();
    
    // Open DM channel first
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
    
    // Send status updates to the user directly
    const message = await client.chat.postMessage({
      channel: dmChannel.channel.id,  // Use the DM channel ID
      text: "🔍 Starting feedback collection process..."
    });

    const service = new FeedbackCollectionService(null, { slackClient: client });
    const session = await service.startSession({
      userId: body.user.id,
      channels: [channelId],
      startDate: start,
      endDate: end
    });

    await handleFeedbackCollection(
      client, 
      dmChannel.channel.id,  // Use the DM channel ID
      message.ts,
      start,
      end,
      session.sessionId,
      channelId  // Pass target channel as extra param
    );
  } catch (error) {
    console.error('Error:', error);
    try {
      // Try to send error message to user's DM
      const dmChannel = await client.conversations.open({
        users: body.user.id
      });
      await client.chat.postMessage({
        channel: dmChannel.channel.id,
        text: `❌ Error: ${error.message}\nPlease try again.`
      });
    } catch (dmError) {
      console.error('Error sending DM:', dmError);
    }
    await ack({
      response_action: "errors",
      errors: {
        channels: "Error starting collection: " + error.message
      }
    });
  }
});

// Create the preview modal view
function createPreviewModal(items) {
  return {
    type: 'modal',
    callback_id: 'preview_feedback_modal',
    title: {
      type: 'plain_text',
      text: 'Feedback Preview'
    },
    blocks: [
      ...items.map((item, index) => ([
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${index + 1}. ${item.title}*`
          },
          accessory: {
            type: 'checkboxes',
            action_id: `include_item_${index}`,
            initial_options: [{
              text: { type: 'plain_text', text: 'Include' },
              value: `${index}`
            }],
            options: [{
              text: { type: 'plain_text', text: 'Include' },
              value: `${index}`
            }]
          }
        },
        {
          type: 'input',
          block_id: `edit_title_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'Title' },
          element: {
            type: 'plain_text_input',
            action_id: 'title_input',
            initial_value: item.title
          }
        },
        {
          type: 'input',
          block_id: `edit_type_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'Type' },
          element: {
            type: 'static_select',
            action_id: 'type_input',
            initial_option: {
              text: { type: 'plain_text', text: item.type },
              value: item.type
            },
            options: [
              { text: { type: 'plain_text', text: 'Bug' }, value: 'bug' },
              { text: { type: 'plain_text', text: 'Feature' }, value: 'feature' },
              { text: { type: 'plain_text', text: 'Improvement' }, value: 'improvement' }
            ]
          }
        },
        {
          type: 'input',
          block_id: `edit_priority_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'Priority' },
          element: {
            type: 'static_select',
            action_id: 'priority_input',
            initial_option: {
              text: { type: 'plain_text', text: item.priority },
              value: item.priority
            },
            options: [
              { text: { type: 'plain_text', text: 'High' }, value: 'high' },
              { text: { type: 'plain_text', text: 'Medium' }, value: 'medium' },
              { text: { type: 'plain_text', text: 'Low' }, value: 'low' }
            ]
          }
        },
        {
          type: 'input',
          block_id: `edit_impact_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'User Impact' },
          element: {
            type: 'plain_text_input',
            action_id: 'impact_input',
            initial_value: item.user_impact,
            multiline: true
          }
        },
        {
          type: 'input',
          block_id: `edit_current_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'Current Behavior' },
          element: {
            type: 'plain_text_input',
            action_id: 'current_input',
            initial_value: item.current_behavior || '',
            multiline: true
          }
        },
        {
          type: 'input',
          block_id: `edit_expected_${index}`,
          optional: true,
          label: { type: 'plain_text', text: 'Expected Behavior' },
          element: {
            type: 'plain_text_input',
            action_id: 'expected_input',
            initial_value: item.expected_behavior || '',
            multiline: true
          }
        },
        {
          type: 'divider'
        }
      ])).flat()
    ],
    submit: {
      type: 'plain_text',
      text: 'Create Jira Tickets'
    },
    close: {
      type: 'plain_text',
      text: 'Cancel'
    }
  };
}

// Handle the preview modal submission
app.view('preview_feedback_modal', async ({ ack, body, view, client }) => {
  try {
    await ack();
    
    const selectedItems = [];
    const values = view.state.values;
    
    Object.keys(values).forEach(blockId => {
      if (blockId.startsWith('include_item_')) {
        const index = parseInt(blockId.split('_')[2]);
        const isIncluded = values[blockId][`include_item_${index}`].selected_options.length > 0;
        
        if (isIncluded) {
          selectedItems.push({
            index,
            sessionId: body.view.private_metadata,  // Add this to store modal
            title: values[`edit_title_${index}`].title_input.value,
            type: values[`edit_type_${index}`].type_input.selected_option.value,
            priority: values[`edit_priority_${index}`].priority_input.selected_option.value,
            user_impact: values[`edit_impact_${index}`].impact_input.value,
            current_behavior: values[`edit_current_${index}`].current_input.value,
            expected_behavior: values[`edit_expected_${index}`].expected_input.value
          });
        }
      }
    });
    
    // Open DM channel for status updates
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
    
    // Send processing message
    const message = await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: "🎫 Creating Jira tickets..."
    });
    
    // Create Jira tickets for selected items
    const service = new FeedbackCollectionService(null, { slackClient: client });
    await service.createJiraTickets(selectedItems);
    
    // Update with completion message
    await client.chat.update({
      channel: dmChannel.channel.id,
      ts: message.ts,
      text: "✅ Jira tickets created successfully!"
    });
  } catch (error) {
    console.error('Error creating tickets:', error);
    // Send error message to user
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
    await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: `❌ Error creating tickets: ${error.message}`
    });
  }
});