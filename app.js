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

  await client.views.update({
    view_id: body.view.id,
    view: {
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
    }
  });
});

// Add this helper function to determine channel type
function getChannelType(channelName) {
  const channelLower = channelName.toLowerCase();
  if (channelLower.includes('expense')) {
    return 'expenses';
  } else if (channelLower.includes('ticket') || channelLower.includes('support')) {
    return 'tickets';
  } else {
    return 'general';
  }
}

// Modify the summary generation handler
app.view('summary_channel_select', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    // Get selected channels and date range
    const selectedChannels = view.state.values.channel_select.channels_selected.selected_channels;
    const startDate = view.state.values.date_start.date_start_input.selected_date;
    const endDate = view.state.values.date_end.date_end_input.selected_date;

    // Collect messages from all selected channels
    const allMessages = [];
    for (const channelId of selectedChannels) {
      console.log(`Processing channel: ${channelId}`);
      const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
      allMessages.push(...messages);
    }

    console.log(`Found ${allMessages.length} messages in date range`);

    // Convert messages to conversation text
    const conversation = allMessages
      .map(msg => {
        const userName = msg.user_info?.name || 'Unknown User';
        return `[${userName}]: ${msg.text || ''}`;
      })
      .filter(text => text.length > 0)
      .join('\n\n');

    // Get channel info to determine type
    const channelInfo = await Promise.all(
      selectedChannels.map(async channelId => {
        const info = await client.conversations.info({ channel: channelId });
        return {
          id: channelId,
          name: info.channel.name,
          type: getChannelType(info.channel.name)
        };
      })
    );

    // Select appropriate prompt based on channel type
    const getPromptForChannel = (channelType) => {
      switch (channelType) {
        case 'expenses':
          return `Analyze this Slack conversation about software expenses and tools. 
          Create a brief, actionable summary focusing on:
          - Key tools discussed
          - Costs and ROI
          - Main decisions/recommendations made by specific team members
          - Next steps and who is responsible
          
          Format as:
          *Summary*
          Brief overview of main points (2-3 sentences), mentioning key contributors

          *Tools & Costs*
          • Tool Name: Cost (if mentioned) - Key points (include who proposed/discussed)
          
          *Decisions*
          • Key decision points or recommendations (include who made/supported the decision)
          
          *Next Steps*
          • Action items (include who is responsible if mentioned)`;
          
        case 'tickets':
          return `Analyze this Slack conversation about technical issues.
          Create a brief, actionable summary focusing on:
          - Key issues discussed and who reported them
          - Solutions proposed and by whom
          - Decisions made and who made them
          - Next steps and who is responsible
          
          Format as:
          *Summary*
          Brief overview of main points (2-3 sentences), mentioning key contributors

          *Key Issues*
          • Issue: Status/Solution (include who reported/solved)
          
          *Decisions*
          • Key decisions made (include who made/supported the decision)
          
          *Next Steps*
          • Action items (include who is responsible if mentioned)`;
          
        default:
          return `Analyze this Slack conversation.
          Create a brief, actionable summary focusing on:
          - Key points discussed and who raised them
          - Decisions made and who made them
          - Next steps and who is responsible
          
          Format as:
          *Summary*
          Brief overview of main points (2-3 sentences), mentioning key contributors

          *Key Points*
          • Main discussion points (include who raised/discussed them)
          
          *Next Steps*
          • Action items (include who is responsible if mentioned)`;
      }
    };

    const channelType = channelInfo[0].type; // Use first channel's type if multiple
    const summaryPrompt = getPromptForChannel(channelType);

    const response = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "system",
          content: `You are an expert at analyzing ${channelType} discussions and creating clear, actionable summaries.`
        },
        {
          role: "user",
          content: `${summaryPrompt}\n\nConversation:\n${conversation}`
        }
      ],
      temperature: 0.7
    });

    // Format the summary for Slack
    const summary = response.choices[0].message.content
      .replace(/^#+\s+/gm, '*') // Replace markdown headers with bold
      .replace(/^[-•]\s+/gm, '• ') // Standardize bullets
      .replace(/\n{3,}/g, '\n\n') // Remove extra newlines
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // Convert double asterisks to single
      .trim();

    const channelsList = channelInfo.map(c => `#${c.name}`).join(', ');
    const dateRange = `${startDate} to ${endDate}`;
    const fallbackText = `Discussion Summary for ${channelsList} (${dateRange})\n\n${summary}`;

    await client.chat.postMessage({
      channel: body.user.id,
      text: fallbackText, // Add fallback text for accessibility
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📊 Discussion Summary",
            emoji: true
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: summary
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*Channels summarized:* ${channelsList}\n*Date range:* ${dateRange}`
            }
          ]
        }
      ]
    });

  } catch (error) {
    console.error('Error generating summary:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error generating summary: ${error.message}` // Error messages already had text
    });
  }
});

// Handle modal submission
app.view('feedback_channels', async ({ ack, body, view, client }) => {
  await ack();
  
  const selectedChannels = view.state.values.channels_block.channels_input.selected_channels;
  const startDate = view.state.values.date_start.date_start_input.selected_date;
  const endDate = view.state.values.date_end.date_end_input.selected_date;

  // Validate date range
  if (new Date(startDate) > new Date(endDate)) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "Error: Start date must be before or equal to end date."
    });
    return;
  }
  
  try {
    const channels = selectedChannels;
    const allFeedback = [];
    
    // Process each channel
    for (const channelId of channels) {
      try {
        // Get channel info for the report
        const channelInfo = await client.conversations.info({ channel: channelId });
        console.log(`Processing channel: ${channelInfo.channel.name}`);
        
        // Fetch messages for date range
        const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
        console.log(`Found ${messages.length} messages in date range`);
        
        // Analyze feedback
        const analyzedFeedback = await analyzeFeedback(messages);
        console.log(`Analysis complete. Found ${analyzedFeedback.length} feedback items`);
        
        if (analyzedFeedback.length > 0) {
          allFeedback.push({
            channel: channelInfo.channel.name,
            feedback: analyzedFeedback
          });
        }
      } catch (error) {
        // Handle specific channel errors
        if (error.data?.error === 'not_in_channel' || error.data?.error === 'is_private') {
          await client.chat.postMessage({
            channel: body.user.id,
            text: `⚠️ Unable to access ${channelInfo?.channel?.name || channelId}: ${error.data.error === 'is_private' ? 
              'This is a private channel. Please add the bot to this channel first.' : 
              'Bot needs to be added to this channel.'}`
          });
          continue;
        }
        throw error;
      }
    }
    
    if (allFeedback.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "No product-related feedback found in the selected date range."
      });
      return;
    }

    // Create a formatted summary for approval
    const summaryBlocks = [];
    summaryBlocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: "📋 Feedback Summary for Review",
        emoji: true
      }
    });

    for (const channelFeedback of allFeedback) {
      summaryBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Channel: #${channelFeedback.channel}*`
        }
      });

      channelFeedback.feedback.forEach((item, index) => {
        summaryBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${index + 1}. ${item.title}*\n${item.summary}\n*Type:* ${item.type}\n*Priority:* ${item.priority}`
          }
        });
      });

      summaryBlocks.push({
        type: "divider"
      });
    }

    // Add approval buttons
    const feedbackId = generateId();
    feedbackStorage.set(feedbackId, {
      feedback: allFeedback,
      startDate,
      endDate
    });

    summaryBlocks.push({
      type: "actions",
      block_id: "approval_buttons",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "👀 Preview Tickets",
            emoji: true
          },
          value: feedbackId,
          action_id: "preview_tickets"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✅ Create Jira Tickets",
            emoji: true
          },
          style: "primary",
          value: feedbackId,
          action_id: "select_project"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "❌ Cancel",
            emoji: true
          },
          style: "danger",
          action_id: "cancel_tickets"
        }
      ]
    });

    // Send the summary message with approval buttons
    await client.chat.postMessage({
      channel: body.user.id,
      blocks: summaryBlocks,
      text: "Feedback Summary for Review" // Fallback text
    });
    
  } catch (error) {
    console.error('Error in feedback collection:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error collecting feedback: ${error.message}`
    });
  }
});

// Add this function before the project_selection handler
function formatJiraCreationReport(results) {
  let report = '';
  
  for (const channelResult of results) {
    report += `*Channel: #${channelResult.channel}*\n`;
    
    // Add excluded tickets first with a red X
    if (channelResult.excludedItems && channelResult.excludedItems.length > 0) {
      for (const excluded of channelResult.excludedItems) {
        report += `❌ Excluded ticket: ${excluded.item.title}\n`;
      }
    }
    
    // Then add the results of created/duplicate tickets
    for (const result of channelResult.results) {
      switch (result.status) {
        case 'created':
          report += `✅ Created ticket ${result.key}: ${result.summary}\n`;
          break;
        case 'duplicate':
          report += `⚠️ Skipped duplicate of ${result.existingIssue}: ${result.summary}\n`;
          break;
        case 'error':
          report += `❌ Failed to create ticket: ${result.summary} (${result.error})\n`;
          break;
      }
    }
    report += '\n';
  }
  
  if (!report) {
    report = 'No tickets were created. All items may have been excluded.';
  }
  
  return report;
}

// Handle project selection
app.action('select_project', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const feedbackId = body.actions[0].value;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'project_selection',
        title: {
          type: 'plain_text',
          text: 'Select Jira Project'
        },
        blocks: [
          {
            type: 'input',
            block_id: 'project_key',
            element: {
              type: 'plain_text_input',
              action_id: 'project_key_input',
              placeholder: {
                type: 'plain_text',
                text: 'Enter Jira project key (e.g., DIVAI)'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Jira Project Key'
            }
          }
        ],
        submit: {
          type: 'plain_text',
          text: 'Create Tickets'
        },
        private_metadata: feedbackId
      }
    });
  } catch (error) {
    console.error('Error opening project selection modal:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error opening project selection modal.'
    });
  }
});

// Handle project selection submission
app.view('project_selection', async ({ ack, body, view, client }) => {
  console.log('Project selection submitted:', {
    body,
    view,
    metadata: view.private_metadata
  });
  
  try {
    await ack();
    
    const feedbackId = view.private_metadata;
    console.log('FeedbackId:', feedbackId);
    
    const feedbackData = feedbackStorage.get(feedbackId);
    console.log('FeedbackData:', feedbackData);
    
    if (!feedbackData) {
      throw new Error('Feedback data not found. Please try collecting feedback again.');
    }

    const results = [];
    
    // First, get all excluded items across all channels
    const excludedItems = new Set(
      Array.from(previewStorage.entries())
        .filter(([_, data]) => 
          data.feedbackId === feedbackId && 
          data.excluded
        )
        .map(([_, data]) => `${data.channelIndex}_${data.itemIndex}`)
    );

    console.log('Excluded items:', excludedItems);

    // Process each channel with its own project key
    for (const channelFeedback of feedbackData.feedback) {
      const projectKey = view.state.values[`project_key_${channelFeedback.channel}`].project_key_input.value.toUpperCase();
      
      // Create array of non-excluded feedback items
      const includedFeedback = channelFeedback.feedback.filter((_, index) => {
        const itemKey = `${channelFeedback.channel}_${index}`;
        return !excludedItems.has(itemKey);
      });

      if (includedFeedback.length > 0) {
        const jiraIssues = await convertToJiraFormat(includedFeedback, projectKey);
        const channelResults = await createJiraIssues(jiraIssues);
        results.push({
          channel: channelFeedback.channel,
          results: channelResults,
          excludedItems: channelFeedback.feedback
            .map((item, index) => ({
              item,
              excluded: excludedItems.has(`${channelFeedback.channel}_${index}`)
            }))
            .filter(item => item.excluded)
        });
      } else {
        // Add channel to results even if no tickets were created, to show excluded items
        results.push({
          channel: channelFeedback.channel,
          results: [],
          excludedItems: channelFeedback.feedback
            .map((item, index) => ({
              item,
              excluded: excludedItems.has(`${channelFeedback.channel}_${index}`)
            }))
            .filter(item => item.excluded)
        });
      }
    }

    // Create a formatted report before cleaning up storage
    const report = formatJiraCreationReport(results);
    const fallbackText = `Jira tickets created!\n\n${report}`;

    // Clean up stored data after generating the report
    feedbackStorage.delete(feedbackId);
    Array.from(previewStorage.keys())
      .filter(key => previewStorage.get(key)?.feedbackId === feedbackId)
      .forEach(key => previewStorage.delete(key));
    
    // Send the final report
    await client.chat.postMessage({
      channel: body.user.id,
      text: fallbackText,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🎫 Jira Tickets Created",
            emoji: true
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: report
          }
        }
      ]
    });
    
  } catch (error) {
    console.error('Error creating Jira tickets:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error creating Jira tickets: ${error.message}`
    });
  }
});

// Handle cancellation
app.action('cancel_tickets', async ({ ack, body, client }) => {
  await ack();
  
  await client.chat.postMessage({
    channel: body.user.id,
    text: "Feedback collection cancelled. No Jira tickets were created."
  });
});

// Handle preview request
app.action('preview_tickets', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const feedbackId = body.actions[0].value;
    const feedbackData = feedbackStorage.get(feedbackId);
    
    if (!feedbackData) {
      throw new Error('Feedback data not found. Please try collecting feedback again.');
    }

    const previewBlocks = [];
    
    // Create preview for each ticket
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
        
        // Find if this item was previously excluded
        const existingPreviewId = Array.from(previewStorage.entries()).find(([_, data]) => 
          data.feedbackId === feedbackId && 
          data.channelIndex === channelFeedback.channel && 
          data.itemIndex === index
        )?.[0];
        
        const wasExcluded = existingPreviewId ? previewStorage.get(existingPreviewId)?.excluded : false;
        
        previewStorage.set(currentPreviewId, {
          feedbackId: feedbackId,
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
                  text: previewStorage.get(currentPreviewId)?.excluded ? "🔄 Include" : "❌ Exclude",
                  emoji: true
                },
                value: currentPreviewId,
                action_id: "toggle_exclude",
                style: previewStorage.get(currentPreviewId)?.excluded ? "primary" : "danger"
              }
            ]
          },
          {
            type: "divider"
          }
        );
      });
    }

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
        private_metadata: feedbackId
      }
    });
  } catch (error) {
    console.error('Error showing preview:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error showing ticket preview.'
    });
  }
});

// Add this handler for the toggle_exclude button
app.action('toggle_exclude', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const previewId = body.actions[0].value;
    const previewData = previewStorage.get(previewId);
    
    if (!previewData) {
      throw new Error('Preview data not found');
    }

    // Toggle the excluded state
    previewData.excluded = !previewData.excluded;
    previewStorage.set(previewId, previewData);

    // Get the feedback data
    const feedbackData = feedbackStorage.get(previewData.feedbackId);
    if (!feedbackData) {
      throw new Error('Feedback data not found');
    }

    // Update just the buttons for this item
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
        blocks: body.view.blocks.map(block => {
          // If this is the actions block containing our button
          if (block.type === 'actions' && 
              block.elements.some(el => el.value === previewId)) {
            return {
              ...block,
              elements: block.elements.map(el => {
                if (el.action_id === 'toggle_exclude') {
                  return {
                    ...el,
                    text: {
                      type: "plain_text",
                      text: previewData.excluded ? "🔄 Include" : "❌ Exclude",
                      emoji: true
                    },
                    style: previewData.excluded ? "primary" : "danger"
                  };
                }
                return el;
              })
            };
          }
          return block;
        }),
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

  } catch (error) {
    console.error('Error toggling exclusion:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error updating preview. Please try again.'
    });
  }
});

// Handle edit button click
app.action('edit_description', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const previewId = body.actions[0].value;
    console.log('Edit button clicked with previewId:', previewId);
    console.log('Current preview storage:', Array.from(previewStorage.entries()));
    
    const previewData = previewStorage.get(previewId);
    if (!previewData) {
      console.error('Preview data not found for ID:', previewId);
      throw new Error('Preview data not found.');
    }

    console.log('Found preview data:', previewData);
    const item = previewData.item;
    
    // Create edit modal blocks
    const editBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Editing: ${item.title}*`
        }
      },
      {
        type: "input",
        block_id: "title",
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          initial_value: item.title || ""
        },
        label: {
          type: "plain_text",
          text: "Title",
          emoji: true
        }
      },
      {
        type: "input",
        block_id: "description",
        element: {
          type: "plain_text_input",
          action_id: "description_input",
          multiline: true,
          initial_value: item.summary || ""
        },
        label: {
          type: "plain_text",
          text: "Description",
          emoji: true
        }
      },
      {
        type: "input",
        block_id: "user_impact",
        element: {
          type: "plain_text_input",
          action_id: "user_impact_input",
          multiline: true,
          initial_value: item.user_impact || ""
        },
        label: {
          type: "plain_text",
          text: "User Impact",
          emoji: true
        }
      },
      {
        type: "input",
        block_id: "current_behavior",
        element: {
          type: "plain_text_input",
          action_id: "current_behavior_input",
          multiline: true,
          initial_value: item.current_behavior || ""
        },
        label: {
          type: "plain_text",
          text: "Current Behavior",
          emoji: true
        }
      },
      {
        type: "input",
        block_id: "expected_behavior",
        element: {
          type: "plain_text_input",
          action_id: "expected_behavior_input",
          multiline: true,
          initial_value: item.expected_behavior || ""
        },
        label: {
          type: "plain_text",
          text: "Expected Behavior",
          emoji: true
        }
      },
      {
        type: "input",
        block_id: "additional_context",
        element: {
          type: "plain_text_input",
          action_id: "additional_context_input",
          multiline: true,
          initial_value: item.additional_context || ""
        },
        label: {
          type: "plain_text",
          text: "Additional Context",
          emoji: true
        },
        optional: true
      }
    ];

    // Open the edit modal
    const result = await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_description_modal",
        title: {
          type: "plain_text",
          text: "Edit Ticket",
          emoji: true
        },
        blocks: editBlocks,
        private_metadata: previewId,
        submit: {
          type: "plain_text",
          text: "Save",
          emoji: true
        },
        close: {
          type: "plain_text",
          text: "Cancel",
          emoji: true
        }
      }
    });

    console.log('Edit modal opened successfully:', result);
  } catch (error) {
    console.error('Error opening edit modal:', error);
    console.error('Error details:', error.data || error.message);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error opening edit modal. Please try again.'
    });
  }
});

// Add this handler for the edit modal submission
app.view('edit_description_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const previewId = view.private_metadata;
    const previewData = previewStorage.get(previewId);
    
    if (!previewData) {
      throw new Error('Preview data not found');
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
      throw new Error('Feedback data not found');
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
          excluded: wasExcluded  // Use the stored exclusion state
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
                  text: previewStorage.get(currentPreviewId)?.excluded ? "🔄 Include" : "❌ Exclude",
                  emoji: true
                },
                value: currentPreviewId,
                action_id: "toggle_exclude",
                style: previewStorage.get(currentPreviewId)?.excluded ? "primary" : "danger"
              }
            ]
          },
          {
            type: "divider"
          }
        );
      });
    }

    // Update the preview modal
    await client.views.update({
      view_id: view.root_view_id, // Use root_view_id to update the preview modal
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

  } catch (error) {
    console.error('Error saving changes:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Error saving changes. Please try again.'
    });
  }
});

// Modify the preview modal submission handler
app.view('preview_modal', async ({ ack, body, view, client }) => {
  try {
    await ack();
    
    console.log('Preview modal submitted:', {
      body,
      view,
      metadata: view.private_metadata
    });
    
    const feedbackId = view.private_metadata;
    const feedbackData = feedbackStorage.get(feedbackId);
    
    if (!feedbackData) {
      console.error('Feedback data not found for ID:', feedbackId);
      throw new Error('Feedback data not found');
    }

    console.log('Found feedback data:', feedbackData);

    // Create input blocks for each channel
    const blocks = [];
    feedbackData.feedback.forEach(channelFeedback => {
      console.log('Processing channel:', channelFeedback.channel);
      blocks.push(
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `Channel: #${channelFeedback.channel}`,
            emoji: true
          }
        },
        {
          type: "input",
          block_id: `project_key_${channelFeedback.channel}`,
          element: {
            type: "plain_text_input",
            action_id: "project_key_input",
            placeholder: {
              type: "plain_text",
              text: "Enter Jira project key (e.g., DIVAI)"
            }
          },
          label: {
            type: "plain_text",
            text: "Jira Project Key",
            emoji: true
          }
        }
      );
    });

    console.log('Opening project selection modal with blocks:', blocks);

    // Open the project selection modal
    const result = await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "project_selection",
        title: {
          type: "plain_text",
          text: "Select Jira Projects",
          emoji: true
        },
        blocks: blocks,
        submit: {
          type: "plain_text",
          text: "Create Tickets",
          emoji: true
        },
        private_metadata: feedbackId
      }
    });

    console.log('Project selection modal opened:', result);

  } catch (error) {
    console.error('Error in preview_modal handler:', error);
    console.error('Error details:', error.data || error.message);
    
    try {
      await ack({
        response_action: "errors",
        errors: {
          "block_id": "Error opening project selection modal. Please try again."
        }
      });
    } catch (ackError) {
      console.error('Error sending ack with errors:', ackError);
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Error opening project selection: ${error.message}`
    });
  }
});

// Add handler for Jira ticket creation mode
app.action('mode_jira', async ({ ack, body, client }) => {
  await ack();
  
  console.log('Jira ticket mode selected');

  // Show channel selection modal with custom prompt for tickets
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
      block_id: "channels_block",
      element: {
        type: "multi_channels_select",
        action_id: "channels_input",
        placeholder: {
          type: "plain_text",
          text: "Select channels to collect feedback from"
        },
        max_selected_items: 10
      },
      label: {
        type: "plain_text",
        text: "Choose Channels"
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
        text: "Start Date"
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
        text: "End Date"
      }
    }
  ];

  try {
    console.log('Updating view with channel selection blocks');
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: "modal",
        callback_id: "feedback_channels",
        title: {
          type: "plain_text",
          text: "Collect Feedback",
          emoji: true
        },
        blocks: blocks,
        submit: {
          type: "plain_text",
          text: "Collect Feedback",
          emoji: true
        }
      }
    });
    console.log('View updated successfully');
  } catch (error) {
    console.error('Error updating view:', error);
    console.error('Error details:', error.data || error.message);
  }
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');
})();