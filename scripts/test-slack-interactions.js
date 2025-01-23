const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');
const dynamoDBService = require('../services/dynamodb-service');

const testSlackInteractions = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, {
    slackClient,
    similarityThreshold: 0.5,
    duplicateCacheDuration: 24
  });

  try {
    console.log('1. Testing channel message retrieval...');
    const messages = await service.getChannelMessages({
      channelId: 'C123456',
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });
    console.log('Retrieved messages:', JSON.stringify(messages, null, 2));

    console.log('\n2. Testing feedback collection from messages...');
    const session = await service.startSession({
      userId: 'U1',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    const feedback = await service.collectFeedbackFromMessages({
      sessionId: session.sessionId,
      channelId: 'C123456',
      messages
    });
    console.log('Collected feedback:', JSON.stringify(feedback, null, 2));

    console.log('\n✅ Slack interaction tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testSlackInteractions();
} 