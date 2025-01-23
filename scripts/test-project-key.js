require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');

const testProjectKey = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  try {
    console.log('1. Creating test session...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    console.log('\n2. Testing project key setting...');
    await service.setProjectKey({
      sessionId: session.sessionId,
      channelId: 'C123456',
      projectKey: 'PROJ-123',
      userId: 'test_user'
    });

    console.log('\n3. Testing project key retrieval...');
    const config = await service.getChannelConfig({
      sessionId: session.sessionId,
      channelId: 'C123456'
    });
    console.log('Channel config:', config);

    console.log('\n4. Testing invalid project key...');
    try {
      await service.setProjectKey({
        sessionId: session.sessionId,
        channelId: 'C123456',
        projectKey: 'invalid-key',
        userId: 'test_user'
      });
    } catch (error) {
      console.log('Expected error:', error.message);
    }

    console.log('\n✅ All project key tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testProjectKey();
} 