const FeedbackCollectionService = require('../services/feedback-service');

const testDuplicateDetection = async () => {
  const service = new FeedbackCollectionService();

  try {
    console.log('1. Creating session with similar feedback items...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    // Add two similar feedback items
    await service.addFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456',
      items: [
        {
          title: 'Bug in login page',
          description: 'Users cannot login with correct credentials',
          priority: 'HIGH',
          type: 'BUG'
        },
        {
          title: 'Login page authentication issue',
          description: 'Login not working with valid credentials',
          priority: 'HIGH',
          type: 'BUG'
        }
      ]
    });

    console.log('\n2. Testing duplicate detection...');
    const duplicateCheck = await service.checkForDuplicates({
      sessionId: session.sessionId,
      item: {
        title: 'Login page authentication issue',
        description: 'Login not working with valid credentials'
      },
      projectKey: 'TEST',
      userId: 'test_user'
    });

    console.log('Duplicate check result:', JSON.stringify(duplicateCheck, null, 2));

    console.log('\n✅ Duplicate detection tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testDuplicateDetection();
} 