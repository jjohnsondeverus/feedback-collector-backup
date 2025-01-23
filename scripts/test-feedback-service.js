require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');

const testFeedbackService = async () => {
  const service = new FeedbackCollectionService();

  try {
    console.log('1. Testing session creation...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });
    console.log('Session created:', session);

    console.log('\n2. Testing feedback addition...');
    await service.addFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456',
      items: [
        {
          title: 'Test Feedback',
          description: 'Testing feedback service',
          priority: 'HIGH',
          type: 'BUG'
        }
      ]
    });

    console.log('\n3. Testing session retrieval...');
    const retrievedSession = await service.getSessionWithItems(session.sessionId);
    console.log('Retrieved session:', JSON.stringify(retrievedSession, null, 2));

    console.log('\n✅ All feedback service tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testFeedbackService();
} 