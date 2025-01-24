require('dotenv').config();
const FeedbackCollectionService = require('../services/feedback-service');
const MockSlackClient = require('../services/mock-slack-client');

const testFeedbackPreview = async () => {
  const slackClient = new MockSlackClient();
  const service = new FeedbackCollectionService(null, { slackClient });

  try {
    console.log('1. Creating test session with feedback...');
    const session = await service.startSession({
      userId: 'test_user',
      channels: ['C123456'],
      startDate: '2024-01-01',
      endDate: '2024-01-07'
    });

    const messages = [
      { text: 'The search is really slow', user: 'U1', ts: '1234567890.000000' },
      { text: 'We need PDF export', user: 'U2', ts: '1234567891.000000' }
    ];

    await service.collectFeedbackFromMessages({
      sessionId: session.sessionId,
      channelId: 'C123456',
      messages
    });

    console.log('\n2. Testing feedback preview...');
    const preview = await service.previewFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456'
    });
    console.log('Preview items:', JSON.stringify(preview, null, 2));

    console.log('\n3. Testing feedback item update...');
    const updateResult = await service.updateFeedbackItem({
      sessionId: session.sessionId,
      channelId: 'C123456',
      itemIndex: 0,
      updates: {
        title: 'Updated Title',
        priority: 'HIGH'
      },
      userId: 'test_user'
    });
    console.log('Update result:', updateResult);

    console.log('\n4. Testing item exclusion...');
    await service.excludeFeedbackItem({
      sessionId: session.sessionId,
      channelId: 'C123456',
      itemIndex: 1,
      userId: 'test_user'
    });

    const finalPreview = await service.previewFeedbackItems({
      sessionId: session.sessionId,
      channelId: 'C123456'
    });
    console.log('Final preview:', JSON.stringify(finalPreview, null, 2));

    console.log('\n✅ All preview tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

// Add timing logs and handle trigger expiration
async function showPreview(client, triggerId, feedbackItems) {
  try {
    console.log('Starting preview creation...');
    const startTime = Date.now();

    // Create modal view payload
    const view = createPreviewModal(feedbackItems);
    
    console.log(`Modal created in ${Date.now() - startTime}ms`);

    // Open view with error handling
    const result = await client.views.open({
      trigger_id: triggerId,
      view: view
    });

    console.log(`View opened in ${Date.now() - startTime}ms`);
    return result;

  } catch (error) {
    if (error.data?.error === 'expired_trigger_id') {
      // Send fallback message to channel
      await client.chat.postMessage({
        channel: channelId,
        text: "Preview timed out. Please try again with a smaller date range or use /collect-feedback-quick for faster processing."
      });
    }
    throw error;
  }
}

async function handleFeedbackCollection(client, body, channelId, startDate, endDate) {
  try {
    const messageId = await client.chat.postMessage({
      channel: channelId,
      text: "🔍 Starting feedback collection process..."
    });
    
    // Function to update progress message
    const updateProgress = async (status, progress) => {
      await client.chat.update({
        channel: channelId,
        ts: messageId.ts,
        text: `${status}\n${progress}`
      });
    };
    
    try {
      // 1. Fetch messages
      await updateProgress("📥 Fetching messages...", "0% complete");
      const messages = await getMessagesInDateRange(client, channelId, startDate, endDate);
      
      // 2. Process messages in batches
      await updateProgress("🤖 Analyzing conversation...", "25% complete");
      const totalMessages = messages.length;
      const batchSize = 50;
      const batches = Math.ceil(totalMessages / batchSize);
      
      for (let i = 0; i < batches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, totalMessages);
        const batch = messages.slice(start, end);
        
        await updateProgress(
          "🤖 Analyzing conversation...", 
          `${Math.round((i + 1) / batches * 50 + 25)}% complete\n` +
          `Processed ${end} of ${totalMessages} messages`
        );
        
        // Process batch
        await processFeedbackBatch(batch);
      }
      
      // 3. Generate feedback items
      await updateProgress("✍️ Generating feedback items...", "75% complete");
      const feedbackItems = await generateFeedbackItems(messages);
      
      // 4. Final preparation
      await updateProgress("📋 Preparing results...", "90% complete");
      
      // Create interactive message
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "✅ Generated feedback items from conversation. Click below to review:"
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
              value: JSON.stringify({ sessionId: session.sessionId })
            }
          ]
        }
      ];

      // 5. Post final message
      await updateProgress("✅ Process complete!", "100% complete");
      await client.chat.postMessage({
        channel: channelId,
        blocks: blocks,
        text: "Feedback items ready for review"
      });

    } catch (error) {
      console.error('Error in feedback collection:', error);
      let errorMessage = "An error occurred during processing.\n\n";
      let suggestion = "";
      
      // Add specific error handling and suggestions
      if (error.message.includes("rate_limited")) {
        suggestion = "• Wait a few minutes and try again\n" +
                    "• Try processing a smaller date range\n" +
                    "• Contact support if the issue persists";
      } else if (error.message.includes("token_expired")) {
        suggestion = "• Try logging out and back in\n" +
                    "• Contact your Slack admin to verify app permissions";
      } else if (error.message.includes("not_in_channel")) {
        suggestion = "• Invite the bot to the channel first\n" +
                    "• Verify the bot has proper channel access";
      } else if (error.message.includes("invalid_auth")) {
        suggestion = "• Verify the app's authentication settings\n" +
                    "• Contact your Slack admin to check app installation";
      } else {
        suggestion = "• Try with a smaller date range\n" +
                    "• Check if the channels are accessible\n" +
                    "• Contact support if the issue continues";
      }
      
      await updateProgress("❌ Error occurred", 
        `${errorMessage}Error details: ${error.message}\n\n` +
        `Suggested actions:\n${suggestion}`
      );
    }
  } catch (error) {
    console.error('Error updating progress:', error);
    // Fallback error message if we can't update the progress
    await client.chat.postMessage({
      channel: channelId,
      text: "❌ Error processing feedback.\n\n" +
           "Please try:\n" +
           "• Refreshing your browser\n" +
           "• Using a smaller date range\n" +
           "• Checking channel permissions\n" +
           "• Contact support if issues persist"
    });
  }
}

// Handle the review button click with a fresh trigger_id
async function handleReviewAction(client, body) {
  try {
    const { sessionId } = JSON.parse(body.actions[0].value);
    const feedbackItems = await getFeedbackItems(sessionId);
    
    // Now we have a fresh trigger_id from the button click
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createPreviewModal(feedbackItems)
    });
  } catch (error) {
    console.error('Error showing review modal:', error);
  }
}

// Mock DynamoDB service
const mockDynamoDBService = {
  addFeedbackItems: async () => { throw new Error('rate_limited: Too many requests'); },
  getFeedbackItems: async () => { throw new Error('rate_limited: Too many requests'); },
  createSession: async () => 'SESSION#test',
  getSession: async () => ({ status: 'ACTIVE' })
};

// Mock clients for error testing
class RateLimitedSlackClient extends MockSlackClient {
  constructor() {
    super();
    this.chat = {
      postMessage: async () => {
        throw new Error('rate_limited: Too many requests');
      },
      update: async () => {
        throw new Error('rate_limited: Too many requests');
      }
    };
    this.conversations = {
      history: async () => {
        throw new Error('rate_limited: Too many requests');
      }
    };
  }
}

class AuthErrorSlackClient extends MockSlackClient {
  constructor() {
    super();
    this.chat = {
      postMessage: async () => {
        throw new Error('invalid_auth: Authentication failed');
      },
      update: async () => {
        throw new Error('invalid_auth: Authentication failed');
      }
    };
    this.conversations = {
      history: async () => {
        throw new Error('invalid_auth: Authentication failed');
      }
    };
  }
}

// Add test cases for different error scenarios
const testErrorScenarios = async () => {
  console.log('\n5. Testing error scenarios...');
  
  // Test rate limit error
  try {
    const client = new RateLimitedSlackClient();
    await handleFeedbackCollection(client, null, 'C123456', '2024-01-01', '2024-01-07');
    console.log('❌ Should have thrown rate limit error');
  } catch (error) {
    console.log('✅ Rate limit error handled:', error.message);
  }

  // Test auth error
  try {
    const client = new AuthErrorSlackClient();
    await handleFeedbackCollection(client, null, 'C123456', '2024-01-01', '2024-01-07');
    console.log('❌ Should have thrown auth error');
  } catch (error) {
    console.log('✅ Auth error handled:', error.message);
  }
};

if (require.main === module) {
  testFeedbackPreview()
    .then(() => testErrorScenarios())
    .catch(error => console.error('\n❌ Test failed:', error));
} 