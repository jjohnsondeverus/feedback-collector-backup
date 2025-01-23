require('dotenv').config();
const cloudwatchService = require('../services/cloudwatch-service');
const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');

const testCloudWatchMetrics = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  try {
    console.log('1. Testing session creation metric...');
    const startTime = Date.now();
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });
    await cloudwatchService.recordOperationLatency(
      'SessionCreation',
      Date.now() - startTime
    );
    console.log('✅ Session creation metric recorded');

    console.log('\n2. Testing feedback collection metric...');
    const feedback = await service.collectFeedbackFromMessages({
      sessionId: session.sessionId,
      channelId: 'C123456',
      messages: [
        { text: 'Test feedback 1', user: 'U1' },
        { text: 'Test feedback 2', user: 'U2' }
      ]
    });
    await cloudwatchService.recordFeedbackCollection(
      session.sessionId,
      feedback.length
    );
    console.log('✅ Feedback collection metric recorded');

    console.log('\n✅ All CloudWatch metrics tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testCloudWatchMetrics();
} 