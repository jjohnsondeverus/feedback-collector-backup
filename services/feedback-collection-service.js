const { DynamoDBService } = require('./dynamodb-service');
const { OpenAIService } = require('./openai-service');

class FeedbackCollectionService {
  constructor(config = {}, services = {}) {
    this.dynamoDBService = services.dynamoDBService || new DynamoDBService();
    this.openAIService = services.openAIService || new OpenAIService();
    this.slackClient = services.slackClient;
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
}

module.exports = { FeedbackCollectionService }; 