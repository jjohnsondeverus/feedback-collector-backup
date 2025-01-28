const { DynamoDBService } = require('./dynamodb-service');
const { OpenAIService } = require('./openai-service');
const { OpenAI } = require('openai');

class FeedbackCollectionService {
  constructor(config = {}, services = {}) {
    this.dynamoDBService = services.dynamoDBService || new DynamoDBService();
    this.openAIService = services.openAIService || new OpenAIService();
    this.slackClient = services.slackClient;
    this.jira = new (require('jira-client'))({
      protocol: 'https',
      host: process.env.JIRA_HOST?.replace(/^https?:\/\//, ''),
      username: process.env.JIRA_USERNAME,
      password: process.env.JIRA_API_TOKEN,
      apiVersion: '2',
      strictSSL: true
    });
  }

  async startSession({ userId, channels, startDate, endDate }) {
    const sessionId = `SESSION#${Date.now()}`;
    await this.dynamoDBService.createSession({
      sessionId,
      userId,
      channels,
      startDate,
      endDate,
      status: 'ACTIVE'
    });
    return { sessionId };
  }

  async collectFeedbackFromMessages({ sessionId, channelId, messages }) {
    const feedback = await this.openAIService.analyzeFeedback(messages);
    await this.dynamoDBService.addFeedbackItems({
      sessionId,
      channelId,
      items: feedback.feedback
    });
    return feedback;
  }

  async previewFeedbackItems({ sessionId, channelId }) {
    const items = await this.dynamoDBService.getFeedbackItems(sessionId, channelId);
    return { items };
  }

  _calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  async createJiraTickets(selectedItems, projectKey) {
    if (!selectedItems || selectedItems.length === 0) {
      throw new Error('No items selected for ticket creation');
    }

    if (!selectedItems[0].sessionId) {
      throw new Error('Session ID is required for ticket creation');
    }

    if (!process.env.JIRA_HOST || !process.env.JIRA_USERNAME || !process.env.JIRA_API_TOKEN) {
      throw new Error('Missing required Jira configuration. Please check your environment variables.');
    }

    if (!projectKey) {
      throw new Error('Jira Project Key is required');
    }

    const items = await this.dynamoDBService.getFeedbackItems(selectedItems[0].sessionId);
    
    if (!items || items.length === 0) {
      throw new Error('No feedback items found for this session');
    }
    
    // Function to check for duplicate issues
    const checkForDuplicate = async (summary, item) => {
      try {
        const jql = `project = "${projectKey}" AND created >= -30d`;
        const results = await this.jira.searchJira(jql);
        const threshold = parseFloat(process.env.DUPLICATE_SIMILARITY_THRESHOLD || 0.3);
        
        // Check each issue for similarity
        for (const issue of results.issues) {
          // Check title similarity
          const titleSimilarity = this._calculateSimilarity(summary, issue.fields.summary);
          
          // Check content similarity
          const currentContent = `${item.user_impact} ${item.current_behavior} ${item.expected_behavior}`.toLowerCase();
          const existingContent = issue.fields.description ? issue.fields.description.toLowerCase() : '';
          const contentSimilarity = this._calculateSimilarity(currentContent, existingContent);
          
          // Calculate overall similarity (weighted average)
          const overallSimilarity = (titleSimilarity * 0.6) + (contentSimilarity * 0.4);
          
          console.log(`Comparing tickets:
            Title: "${summary}" with "${issue.fields.summary}"
            Title Similarity: ${titleSimilarity}
            Content Similarity: ${contentSimilarity}
            Overall Similarity: ${overallSimilarity}
          `);
          
          if (overallSimilarity >= threshold) {
            return issue;
          }
        }
        return null;
      } catch (error) {
        console.error('Error checking for duplicates:', error);
        return null;
      }
    };
    
    const tickets = await Promise.all(selectedItems.map(async (selected) => {
      const item = items.find((_, index) => index === selected.index);
      if (!item) return null;

      try {
        // Check for duplicates
        const duplicate = await checkForDuplicate(selected.title, item);
        if (duplicate) {
          return {
            skipped: true,
            title: selected.title,
            duplicateKey: duplicate.key
          };
        }
        
        // Create Jira issue
        const issue = await this.jira.addNewIssue({
          fields: {
            project: { key: projectKey },
            summary: selected.title || item.title,
            description: this._createJiraDescription(item),
            issuetype: { name: this._mapTypeToJira(item.type) },
            priority: { name: this._mapPriorityToJira(item.priority) }
          }
        });
        console.log(`Created Jira ticket: ${issue.key}`);
        return {
          ...issue,
          skipped: false,
          title: selected.title || item.title
        };
      } catch (error) {
        console.error('Error creating Jira ticket:', error);
        throw new Error(`Failed to create Jira ticket: ${error.message}`);
      }
    }));

    return tickets.filter(Boolean);
  }

  _mapTypeToJira(type) {
    const typeMap = {
      bug: 'Bug',
      feature: 'New Feature',
      improvement: 'Improvement'
    };
    return typeMap[type.toLowerCase()] || 'Task';
  }

  _mapPriorityToJira(priority) {
    const priorityMap = {
      high: 'High',
      medium: 'Medium',
      low: 'Low'
    };
    return priorityMap[priority.toLowerCase()] || 'Medium';
  }

  _createJiraDescription(item) {
    return `
h2. User Impact
${item.user_impact}

h2. Current Behavior
${item.current_behavior || 'N/A'}

h2. Expected Behavior
${item.expected_behavior || 'N/A'}

h2. Additional Context
${item.additional_context || 'N/A'}
    `.trim();
  }

  async generateChannelSummary(messages, startDate, endDate) {
    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      
      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
        messages: [
          {
            role: "system",
            content: `Create a comprehensive summary of these Slack conversations:
              
              Format the output EXACTLY as follows:
              
              TECHNICAL ISSUES & DECISIONS
              • 🔴 [High Priority] [Issue title] (First seen: [date])
              • 🟡 [Medium Priority] [Issue title] (First seen: [date])
              • 🟢 [Low Priority] [Issue title] (First seen: [date])
              (continue up to 8 items)
              
              CRITICAL ACTION ITEMS
              • ⏰ [Urgent] [Action item] (Due: [date])
              • 📋 [Planned] [Action item] (Added: [date])
              (continue up to 5 items)
              
              Important: 
              - Keep each point to one line
              - Use bullet points (•)
              - Cover the entire time period
              - Total summary under 2000 characters
              
              Priority Indicators:
              🔴 High Priority/Blocking
              🟡 Medium Priority/Important
              🟢 Low Priority/Enhancement
              
              Status Indicators:
              ⏰ Urgent/Time-sensitive
              📋 Planned/Scheduled
              ⚠️ Needs Attention
              ✅ Resolved/Complete`
          },
          {
            role: "user",
            content: `Time period: ${startDate} to ${endDate}\n\nMessages: ${JSON.stringify(messages)}`
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error generating summary:', error);
      throw error;
    }
  }

  function createAnalysisPrompt(messages, channelType = 'general') {
    const channelSpecificGuidance = {
      expenses: `
        For expense-related channels:
        - Focus on software/tool discussions
        - Identify evaluation requests, purchases, renewals, and cancellations
        - Track cost implications and ROI discussions
        - Note vendor comparisons and pricing details
        - Flag budget-related decisions
        
        Categorize issues as:
        - "evaluation" for new tool assessments
        - "purchase" for new acquisitions
        - "renewal" for subscription continuations
        - "cancellation" for service terminations
        - "research" for vendor/tool investigations`,
      
      technical: `
        For technical channels:
        - Focus on bugs, features, and improvements
        - Track integration issues and dependencies
        - Note architectural decisions
        - Identify security concerns
        - Flag performance issues
        
        Categorize issues as:
        - "Bug" for defects and issues
        - "Feature" for new functionality
        - "Improvement" for enhancements`,
      
      general: `
        For general discussion channels:
        - Focus on decisions and action items
        - Track process improvements
        - Note policy changes
        - Identify coordination needs
        
        Categorize issues as:
        - "Task" for general action items
        - "Story" for larger initiatives
        - "Improvement" for process enhancements`
    };

    return `Analyze these Slack messages and identify distinct issues that need tickets.
    
    ${channelSpecificGuidance[channelType] || channelSpecificGuidance.general}
    
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
      type: ${channelType === 'expenses' ? '"evaluation" | "purchase" | "renewal" | "cancellation" | "research"' : '"Bug" | "Feature" | "Improvement" | "Task"'}
      priority: "High" | "Medium" | "Low"
      user_impact: Specific business/user effect
      current_behavior: Precise current state
      expected_behavior: Clear desired outcome`;
  }
}

module.exports = { FeedbackCollectionService }; 