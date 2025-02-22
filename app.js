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
  host: process.env.JIRA_HOST?.replace(/^https?:\/\//, ''),  // Remove protocol if present
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
  console.log('Fetching messages for channel:', channelId);
  console.log('Date range:', startDate, 'to', endDate);

  try {
    // First, get channel info to check if it's private
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      console.log('Channel type:', channelInfo.channel.is_private ? 'private' : 'public');
      
      if (channelInfo.channel.is_private) {
        // For private channels, we can't join automatically
        console.log('Private channel detected');
      } else {
        // For public channels, try to join
    try {
      await client.conversations.join({ channel: channelId });
          console.log('Successfully joined channel');
    } catch (joinError) {
          if (joinError.data?.error !== 'already_in_channel') {
        throw joinError;
      }
        }
      }
    } catch (infoError) {
      if (infoError.data?.error === 'channel_not_found') {
        throw new Error('Unable to access channel. For private channels, please invite the bot using /invite @YourBotName');
      }
      throw infoError;
    }

    const messages = [];
    let cursor;

    do {
    const result = await client.conversations.history({
      channel: channelId,
        limit: 100,
        cursor: cursor,
        oldest: Math.floor(new Date(startDate).getTime() / 1000),
        latest: Math.floor(new Date(endDate).setHours(23, 59, 59, 999) / 1000)
      });

      console.log(`Fetched ${result.messages?.length || 0} messages`);
      
      if (result.messages) {
        messages.push(...result.messages);
      }
      
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    return messages;
  } catch (error) {
    console.error('Error in getMessagesInDateRange:', error);
    console.error('Channel ID:', channelId);
    console.error('Error details:', JSON.stringify(error.data || {}, null, 2));
    
    if (error.data?.error === 'channel_not_found' || error.data?.error === 'not_in_channel') {
      throw new Error('Unable to access channel. For private channels, please invite the bot using /invite @YourBotName');
    }
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

// Add helper functions for message preprocessing
function preprocessMessages(messages) {
  // First, normalize and clean all messages
  const cleanedMessages = messages.map(msg => ({
    ...msg,
    text: msg.text.replace(/\s+/g, ' ').trim(),  // Normalize whitespace
    ts: msg.ts || '0',
    thread_ts: msg.thread_ts || msg.ts || '0'
  }));
  
  // Sort all messages by timestamp first
  cleanedMessages.sort((a, b) => a.ts.localeCompare(b.ts));

  // Group by thread
  const threadGroups = cleanedMessages.reduce((acc, msg) => {
      const threadKey = msg.thread_ts || msg.ts;
      if (!acc[threadKey]) {
      acc[threadKey] = {
        messages: [],
        keywords: new Set(),
        topics: new Set(),
        timestamp: msg.ts,  // Keep original timestamp for sorting
        originalMessage: msg.text,  // Store original message
        mainMessage: msg.thread_ts ? null : msg.text
      };
    }
    
    // Extract keywords and topics with more specific patterns
    const text = msg.text.toLowerCase();
    const keywords = new Set([
      ...(text.match(/\b(error|bug|issue|problem|feature|request|improvement|fail|broken|not work|doesn't work|incorrect|wrong)\b/g) || []),
      ...(text.match(/\b(need|should|must|require|missing|can't|cannot|unable)\b/g) || [])
    ]);
    
    const topics = new Set([
      ...(text.match(/\b(workday|gliffy|email|integration|encryption|mvr|ukg|oauth|i-?9|tenant)\b/g) || []),
      ...(text.match(/\b(security|performance|access|permission|credential)\b/g) || [])
    ]);
    
    // Add all keywords and topics
    keywords.forEach(k => acc[threadKey].keywords.add(k));
    topics.forEach(t => acc[threadKey].topics.add(t));
    
    acc[threadKey].messages.push({
      text: msg.text,
      user: msg.user,
      ts: msg.ts,
      thread_ts: msg.thread_ts
    });
    
      return acc;
    }, {});

  // Sort threads by timestamp
  const sortedThreads = Object.entries(threadGroups)
    .sort(([, a], [, b]) => a.timestamp.localeCompare(b.timestamp))
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

  // Group related threads by topic
  const topicGroups = {};
  Object.entries(sortedThreads).forEach(([threadKey, thread]) => {
    Array.from(thread.topics).forEach(topic => {
      if (!topicGroups[topic]) {
        topicGroups[topic] = [];
      }
      topicGroups[topic].push({
        threadKey,
        ...thread
      });
    });
  });

      return {
    threads: sortedThreads,
    topics: topicGroups
  };
}

// Add helper to identify potential issues in function
function identifyPotentialIssues(messages) {
  const issues = new Map();
  const issueIndicators = [
    'error', 'bug', 'issue', 'problem', 'broken', 'wrong',
    'need', 'should', 'must', 'require', 'missing',
    'can\'t', 'cannot', 'unable', 'fail', 'failing'
  ];

  // First pass: Find thread starters that indicate issues
  Object.entries(messages.threads)
    .sort(([, a], [, b]) => a.timestamp.localeCompare(b.timestamp))
    .forEach(([threadKey, thread]) => {
      const mainMessage = thread.mainMessage?.toLowerCase() || '';
      
      // Check if main message indicates an issue
      const hasIssueIndicator = issueIndicators.some(indicator => 
        mainMessage.includes(indicator)
      );
      
      if (hasIssueIndicator) {
        const key = `${thread.timestamp}_${mainMessage.slice(0, 50)}`;
        issues.set(key, {
          mainMessage: thread.mainMessage,
          timestamp: thread.timestamp,
          messages: thread.messages,
          components: Array.from(thread.topics),
          keywords: Array.from(thread.keywords)
        });
      }
    });

  return Array.from(issues.values());
}

function createAnalysisPrompt(messages) {
  return `Analyze these Slack messages and identify distinct issues that need tickets.
  
  Required Analysis Steps:
  1. First pass - Identify all potential issues:
    - Process messages in chronological order
    - Look for any mention of problems, needs, or requirements
    - Flag all technical issues, regardless of complexity
    - Do not skip any potential issues
  
  2. Second pass - Group related mentions:
    - Find all mentions of the same issue across threads
    - Group by specific technical component (e.g., Workday integration, OAuth)
    - Keep track of all related discussions
  
  3. For each identified issue group:
    - Create a separate ticket for each distinct problem
    - Do not combine issues unless they are exactly the same
    - Include all relevant context from related mentions
  
  4. For each final ticket, verify and include:
    - Different aspects of the same system should be separate tickets
    - Different user impacts should be separate tickets
    - Different expected behaviors should be separate tickets
    - Only combine if describing exactly the same issue
  
  5. Format each ticket EXACTLY as:
    title: One-line summary of the issue
    type: "Bug" | "Feature" | "Improvement"
    priority: "High" | "Medium" | "Low"
    user_impact: Specific business/user effect
    current_behavior: Precise current state
    expected_behavior: Clear desired outcome
  
  Important:
  - Process ALL messages
  - Include all valid issues found
  - Keep distinct problems separate
  - Be thorough in analysis
  
  Return array of issues sorted by title.`;
}

async function analyzeFeedback(messages) {
  try {
    const processedThreads = preprocessMessages(messages);
    
    // First identify potential issues deterministically
    const potentialIssues = identifyPotentialIssues(processedThreads);
    
    console.log('Potential issues identified:', potentialIssues.length);
    potentialIssues.forEach((issue, index) => {
      console.log(`Issue ${index + 1}:`, {
        message: issue.mainMessage?.slice(0, 100),
        components: issue.components,
        keywords: issue.keywords
      });
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-2024-11-20',
      messages: [
        { 
          role: 'system', 
          content: `You are a software development project manager analyzing potential issues.
            For each issue provided:
            1. Validate it meets these criteria:
               - Clear technical problem or feature request
               - Specific user/business impact
               - Actionable solution possible
            2. If valid, extract:
               - Clear title
               - Issue type
               - Priority based on impact
               - Current and expected behavior
            3. If invalid, exclude it
            
            Return array of valid issues only.
            Process ALL issues independently.
            Do not combine or skip any valid issues.`
        },
        {
          role: 'user',
          content: JSON.stringify(potentialIssues)
        }
      ],
      temperature: 0,  // Use 0 for maximum consistency
      max_tokens: 4096,
      response_format: { type: "json" }
    });

    const response = JSON.parse(completion.choices[0].message.content);
    
    // Log analysis results
    console.log('Analysis results:', {
      potentialIssues: potentialIssues.length,
      validatedIssues: response.length,
      excluded: potentialIssues.length - response.length
    });
    
    return response.sort((a, b) => a.title.localeCompare(b.title));
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
      model: "gpt-4o-2024-11-20",
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
      temperature: 0.3,
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
          types: 'public_channel,private_channel',  // Keep this as is for the API call
          exclude_archived: true,
          limit: 1000
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
      view: {
        ...createPreviewModal(preview.items),
        private_metadata: sessionId  // Store sessionId in modal metadata
      }
    });
  } catch (error) {
    console.error('Error showing preview:', error);
  }
});

// Handle the slash command
app.command('/collect-feedback', async ({ ack, body, client }) => {
  try {
    await ack();
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'channel_select_modal',
        title: {
          type: 'plain_text',
          text: 'Feedback Collection'
        },
        blocks: [
          {
            type: 'input',
            block_id: 'process_type',
            label: {
              type: 'plain_text',
              text: 'Select Process Type'
            },
            element: {
              type: 'radio_buttons',
              action_id: 'process_selected',
              initial_option: {
        text: {
                  type: 'plain_text',
                  text: 'Create Jira Tickets'
      },
                value: 'tickets'
              },
              options: [
      {
            text: {
                    type: 'plain_text',
                    text: 'Create Jira Tickets'
            },
                  value: 'tickets'
          },
          {
            text: {
                    type: 'plain_text',
                    text: 'Generate Summary'
                  },
                  value: 'summary'
                }
              ]
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'channel_select',
      label: {
              type: 'plain_text',
              text: 'Select Channel'
            },
            element: {
              type: 'conversations_select',
              action_id: 'channel_selected',
              filter: {
                include: ["private", "public"],
                exclude_bot_users: true
              }
            }
          },
          // Start date picker
          {
            type: 'input',
            block_id: 'startDate',
            label: {
              type: 'plain_text',
              text: 'Start Date'
            },
      element: {
              type: 'datepicker',
              action_id: 'datepicker',
        placeholder: {
                type: 'plain_text',
                text: 'Select start date'
              }
            }
          },
          // End date picker
          {
            type: 'input',
            block_id: 'endDate',
            label: {
              type: 'plain_text',
              text: 'End Date'
            },
      element: {
              type: 'datepicker',
              action_id: 'datepicker',
        placeholder: {
                type: 'plain_text',
                text: 'Select end date'
              }
            }
          }
        ],
    submit: {
          type: 'plain_text',
          text: 'Process Feedback',
      emoji: true
    }
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
  
    console.log('Creating channel selector modal...');
    
    // Show the date/channel picker modal
    await client.views.push({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'collect_feedback_modal',
        title: {
          type: 'plain_text',
          text: 'Select Channel and Dates'
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Note:* For private channels, please invite the bot using `/invite @YourBotName` before collecting feedback.'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'channel_select',
            label: {
              type: 'plain_text',
              text: 'Select Channel'
            },
      element: {
              type: 'conversations_select',
        placeholder: {
                type: 'plain_text',
                text: 'Select a channel'
              },
              filter: {
                include: ['private', 'public'],
                exclude_bot_users: true
              },
              action_id: 'channel_selected'
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
              action_id: 'start_date',
              placeholder: { type: 'plain_text', text: 'Select start date' }
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
              action_id: 'end_date',
              placeholder: { type: 'plain_text', text: 'Select end date' }
            }
          }
        ],
    submit: {
          type: 'plain_text',
          text: 'Collect'
        }
      }
    });
    console.log('Modal created successfully');
  } catch (error) {
    console.error('Error creating modal:', error);
    console.error('Error details:', JSON.stringify(error.data || {}, null, 2));
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
    // Get values from the modal
    const channelId = view.state.values.channel_select.channel_selected.selected_conversation;
    const startDate = view.state.values.startDate.datepicker.selected_date;
    const endDate = view.state.values.endDate.datepicker.selected_date;

    await ack();

    console.log('Selected channel:', channelId);
    console.log('Date range:', startDate, 'to', endDate);

    // Create a session ID
    const sessionId = `SESSION#${Date.now()}`;

    // Open DM channel first
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });

    // Send initial progress message
    const message = await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: "🔄 Starting feedback collection..."
    });

    // Start the feedback collection process
    await handleFeedbackCollection(
      client,
      dmChannel.channel.id,
      message.ts,
      startDate,
      endDate,
      sessionId,
      channelId  // Make sure we're passing the channel ID here
    );
      } catch (error) {
    console.error('Error in collect_feedback_modal:', error);
    console.error('Error details:', JSON.stringify(error.data || {}, null, 2));

    // Notify user of error
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
      await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: `❌ Error collecting feedback: ${error.message}`
    });
  }
});

// Create the preview modal view
function createPreviewModal(items) {
  // Helper to ensure valid type value
  const normalizeType = (type) => {
    const validTypes = ['bug', 'feature', 'improvement'];
    const normalized = type?.toLowerCase() || 'bug';
    return validTypes.includes(normalized) ? normalized : 'bug';
  };

  // Helper to ensure valid priority value
  const normalizePriority = (priority) => {
    const validPriorities = ['high', 'medium', 'low'];
    const normalized = priority?.toLowerCase() || 'medium';
    return validPriorities.includes(normalized) ? normalized : 'medium';
  };

  return {
    type: 'modal',
    callback_id: 'preview_feedback_modal',
    title: {
      type: 'plain_text',
      text: 'Feedback Preview'
    },
    notify_on_close: true,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Instructions:*\n• Check the boxes for items you want to create tickets for\n• Edit fields as needed\n• Title, Type, and Priority are required'
        }
      },
      {
        type: 'input',
        block_id: 'jira_project',
            element: {
          type: 'plain_text_input',
          action_id: 'project_key',
              placeholder: {
            type: 'plain_text',
            text: 'e.g., CORE, PLAT, etc.'
              }
            },
            label: {
          type: 'plain_text',
          text: 'Jira Project Key',
          emoji: true
        }
      },
      {
        type: 'divider'
      },
      ...items.map((item, index) => {
        const type = normalizeType(item.type);
        const priority = normalizePriority(item.priority);

        return [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${index + 1}. ${item.title}*\n${item.summary || ''}`
            },
            accessory: {
              type: 'checkboxes',
              action_id: `include_item_${index}`,
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
                text: { type: 'plain_text', text: 'Bug' },
                value: 'bug'
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
                text: { type: 'plain_text', text: 'High' },
                value: 'high'
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
        ];
      }).flat()
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

    const sessionId = view.private_metadata;
    const selectedItems = [];
    const values = view.state.values;
    
    // Get the project key
    const projectKey = values.jira_project?.project_key?.value?.toUpperCase();
    if (!projectKey) {
      throw new Error('Please enter a Jira Project Key');
    }
    
    // Validate project key format (typically uppercase letters followed by numbers)
    if (!/^[A-Z][A-Z0-9_]+$/.test(projectKey)) {
      throw new Error('Invalid Jira Project Key format. Should be letters and numbers (e.g., CORE, PLAT)');
    }
    
    console.log('Modal values:', JSON.stringify(values, null, 2));
    
    // First, find all selected items
    const selectedIndices = new Set();
    Object.entries(values).forEach(([blockId, blockValue]) => {
      // Check if this block contains checkbox selections
      const checkboxes = Object.values(blockValue)[0];
      if (checkboxes?.type === 'checkboxes' && checkboxes.selected_options?.length > 0) {
        // Extract the index from the selected option value
        const index = parseInt(checkboxes.selected_options[0].value);
        if (!isNaN(index)) {
          selectedIndices.add(index);
        }
      }
    });
    
    console.log('Selected indices:', Array.from(selectedIndices));
    
    // Then process the selected items
    selectedIndices.forEach(index => {
      // Get the edited values for this item
      const titleBlock = values[`edit_title_${index}`]?.title_input?.value;
      const typeBlock = values[`edit_type_${index}`]?.type_input?.selected_option?.value;
      const priorityBlock = values[`edit_priority_${index}`]?.priority_input?.selected_option?.value;
      const impactBlock = values[`edit_impact_${index}`]?.impact_input?.value;
      const currentBlock = values[`edit_current_${index}`]?.current_input?.value;
      const expectedBlock = values[`edit_expected_${index}`]?.expected_input?.value;
      
      console.log(`Processing item ${index}:`, {
        title: titleBlock,
        type: typeBlock,
        priority: priorityBlock
      });
      
      // Only add if we have the required fields
      if (titleBlock && typeBlock && priorityBlock) {
        selectedItems.push({
          index,
          sessionId,
          title: titleBlock,
          type: typeBlock,
          priority: priorityBlock,
          user_impact: impactBlock || '',
          current_behavior: currentBlock || '',
          expected_behavior: expectedBlock || ''
        });
      } else {
        console.log(`Missing required fields for item ${index}`);
      }
    });
    
    if (selectedItems.length === 0) {
      if (selectedIndices.size > 0) {
        throw new Error('Please ensure all required fields (Title, Type, Priority) are filled for selected items');
      } else {
        throw new Error('Please select at least one item to create tickets for');
      }
    }
    
    console.log('Selected items:', JSON.stringify(selectedItems, null, 2));
    
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
    const createdTickets = await service.createJiraTickets(selectedItems, projectKey);
    
    // Update with completion message
    const ticketSummary = createdTickets.map(ticket => {
      if (ticket.skipped) {
        return `• ${ticket.title} - Skipped (Duplicate of <https://${process.env.JIRA_HOST}/browse/${ticket.duplicateKey}|${ticket.duplicateKey}>)`;
      } else {
        return `• <https://${process.env.JIRA_HOST}/browse/${ticket.key}|${ticket.key}> - ${ticket.title}`;
      }
    }).join('\n');
    
    const successCount = createdTickets.filter(t => !t.skipped).length;
    const skippedCount = createdTickets.filter(t => t.skipped).length;
    
    const statusMessage = [
      `✅ *Jira tickets processed:*`,
      `• *Created:* ${successCount}`,
      `• *Skipped:* ${skippedCount}`,
      '',
      ticketSummary
    ].join('\n');
    
    await client.chat.update({
      channel: dmChannel.channel.id,
      ts: message.ts,
      text: statusMessage,
      mrkdwn: true,
      unfurl_links: false  // Prevent Slack from expanding the links into previews
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

// Create the channel selector modal
async function createChannelSelectorModal(client, triggerId) {
  try {
    console.log('Creating channel selector modal...');
    const result = await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'channel_select_modal',
        title: {
          type: 'plain_text',
          text: 'Feedback Collection'
        },
        blocks: [
          {
            type: 'input',
            block_id: 'process_type',
            label: {
              type: 'plain_text',
              text: 'Select Process Type'
            },
            element: {
              type: 'radio_buttons',
              action_id: 'process_selected',
              initial_option: {
      text: {
                  type: 'plain_text',
                  text: 'Create Jira Tickets'
                },
                value: 'tickets'
              },
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Create Jira Tickets'
                  },
                  value: 'tickets'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Generate Summary'
                  },
                  value: 'summary'
                }
              ]
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'channel_select',
      label: {
              type: 'plain_text',
              text: 'Select Channel'
            },
            element: {
              type: 'conversations_select',
              action_id: 'channel_selected',
              filter: {
                include: ["private", "public"],
                exclude_bot_users: true
              }
            }
          },
          // Start date picker
          {
            type: 'input',
            block_id: 'startDate',
            label: {
              type: 'plain_text',
              text: 'Start Date'
            },
      element: {
              type: 'datepicker',
              action_id: 'datepicker',
        placeholder: {
                type: 'plain_text',
                text: 'Select start date'
              }
        }
      },
          // End date picker
          {
            type: 'input',
            block_id: 'endDate',
      label: {
              type: 'plain_text',
              text: 'End Date'
            },
            element: {
              type: 'datepicker',
              action_id: 'datepicker',
              placeholder: {
                type: 'plain_text',
                text: 'Select end date'
              }
            }
          }
        ],
    submit: {
          type: 'plain_text',
          text: 'Process Feedback',
      emoji: true
    }
      }
    });
    console.log('Modal created successfully');
    return result;
  } catch (error) {
    console.error('Error creating modal:', error);
    throw error;
  }
}

// Handle the modal submission
app.view('channel_select_modal', async ({ ack, body, view, client }) => {
  try {
    // Get values from the modal
    const channelId = view.state.values.channel_select.channel_selected.selected_conversation;
    const startDate = view.state.values.startDate.datepicker.selected_date;
    const endDate = view.state.values.endDate.datepicker.selected_date;
    const processType = view.state.values.process_type.process_selected.selected_option.value;
    
    await ack();
    
    // Open DM channel for status updates
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
    
    // Send initial progress message
    const message = await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: "🔄 Starting feedback collection..."
    });
    
    // Get messages from the channel
    const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
    
    // Process based on selected type
    if (processType === 'summary') {
      // Generate summary
      const service = new FeedbackCollectionService(null, { slackClient: client });
      const summary = await service.generateChannelSummary(messages, startDate, endDate);
      
      // Format and send summary
      await client.chat.update({
        channel: dmChannel.channel.id,
        ts: message.ts,
        text: "Channel Summary", // Fallback text
        blocks: [
          {
        type: "header",
        text: {
          type: "plain_text",
              text: `📋 Channel Summary: #${channelId}`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Date Range:* ${startDate} to ${endDate}`
            }
          },
          {
            type: "divider"
          },
          {
            type: "section",
                text: {
              type: "mrkdwn",
              text: `${summary}\n\n*Legend:*\n🔴 High Priority  🟡 Medium Priority  🟢 Low Priority\n⏰ Urgent  📋 Planned  ⚠️ Needs Attention  ✅ Resolved`
            }
          }
        ]
        });
      } else {
      // Create tickets (existing functionality)
      const sessionId = `SESSION#${Date.now()}`;
      await handleFeedbackCollection(
        client,
        dmChannel.channel.id,
        message.ts,
        startDate,
        endDate,
        sessionId,
        channelId
      );
    }
  } catch (error) {
    console.error('Error processing feedback:', error);
    // Send error message to user
    const dmChannel = await client.conversations.open({
      users: body.user.id
    });
    await client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: `❌ Error: ${error.message}`
    });
  }
});