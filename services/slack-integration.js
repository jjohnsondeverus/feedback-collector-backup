const FeedbackCollectionService = require('./feedback-service');
const { App } = require('@slack/bolt');
const dynamoDBService = require('./dynamodb-service');

class SlackFeedbackIntegration {
  constructor(slackClient, jiraClient, config = {}) {
    this.slackClient = slackClient;
    this.feedbackService = new FeedbackCollectionService(jiraClient, config);
  }

  // Handle the initial feedback collection command
  async handleFeedbackCollection({ userId, channels, startDate, endDate }) {
    try {
      // Start a new session
      const session = await this.feedbackService.startSession({
        userId,
        channels,
        startDate,
        endDate
      });

      // Process each channel
      for (const channelId of channels) {
        const messages = await this.getMessagesInDateRange(channelId, startDate, endDate);
        const feedback = await this.analyzeFeedback(messages);

        if (feedback.length > 0) {
          await this.feedbackService.addFeedbackItems({
            sessionId: session.sessionId,
            channelId,
            items: feedback
          });
        }
      }

      return session;

    } catch (error) {
      console.error('Error in feedback collection:', error);
      throw error;
    }
  }

  // Handle preview modal submission
  async handlePreviewSubmission({ sessionId, projectKey, userId }) {
    try {
      const results = await this.feedbackService.processFeedbackItems({
        sessionId,
        projectKey
      });

      // Format results for Slack message
      let message = "*Jira Ticket Creation Results:*\n\n";

      if (results.created.length > 0) {
        message += "*Created Tickets:*\n" + 
          results.created.map(r => `• <${process.env.JIRA_HOST}/browse/${r.key}|${r.key}> - ${r.summary}`).join('\n') + 
          '\n\n';
      }

      if (results.duplicates.length > 0) {
        message += "*Potential Duplicates:*\n" +
          results.duplicates.map(r => {
            const source = r.fromCache ? ' (from cache)' : '';
            return `• ${r.summary} (similar to <${process.env.JIRA_HOST}/browse/${r.existingIssue}|${r.existingIssue}>${source})`;
          }).join('\n') +
          '\n\n';
      }

      if (results.errors.length > 0) {
        message += "*Errors:*\n" +
          results.errors.map(r => `• ${r.summary}: ${r.error}`).join('\n') +
          '\n\n';
      }

      return {
        results,
        message
      };

    } catch (error) {
      console.error('Error processing feedback items:', error);
      throw error;
    }
  }

  // Preserved helper methods
  async getMessagesInDateRange(channelId, startDate, endDate) {
    try {
      // Try to join the channel first
      try {
        await this.slackClient.conversations.join({ channel: channelId });
      } catch (joinError) {
        if (joinError.data?.error !== 'already_in_channel' && joinError.data?.error !== 'is_private') {
          throw joinError;
        }
      }

      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(endDate).setHours(23, 59, 59, 999) / 1000);

      const result = await this.slackClient.conversations.history({
        channel: channelId,
        oldest: startTimestamp.toString(),
        latest: endTimestamp.toString(),
        inclusive: true,
        limit: 1000
      });

      // Get user info for all messages
      const userIds = new Set(result.messages.map(msg => msg.user));
      const userInfo = {};
      
      for (const userId of userIds) {
        try {
          const info = await this.slackClient.users.info({ user: userId });
          userInfo[userId] = {
            name: info.user.real_name || info.user.name,
            email: info.user.profile.email
          };
        } catch (error) {
          console.warn(`Could not fetch info for user ${userId}:`, error.message);
          userInfo[userId] = { name: 'Unknown User', email: '' };
        }
      }

      // Add user info to messages
      return result.messages.map(msg => ({
        ...msg,
        user_info: userInfo[msg.user]
      }));

    } catch (error) {
      console.error('Error fetching messages:', error);
      throw error;
    }
  }

  // Analyze feedback using existing GPT-4 logic (preserved from original)
  async analyzeFeedback(messages) {
    // Your existing analyzeFeedback implementation
    // This would include the GPT-4 analysis logic
  }
}

module.exports = SlackFeedbackIntegration;