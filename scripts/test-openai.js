require('dotenv').config();
const openAIService = require('../services/openai-service');

const testOpenAIAnalysis = async () => {
  try {
    console.log('1. Testing feedback analysis...');
    const testMessages = [
      "The search function is really slow when there are lots of results",
      "It would be great if we could export reports to PDF",
      "Just checking if everyone's ready for the meeting",
      "The app keeps crashing when I try to upload large files"
    ];

    const analysis = await openAIService.analyzeFeedback(testMessages);
    console.log('Analysis result:', JSON.stringify(analysis, null, 2));

    console.log('\n✅ OpenAI analysis test passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
};

if (require.main === module) {
  testOpenAIAnalysis();
} 