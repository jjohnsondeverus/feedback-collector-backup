const OpenAI = require('openai');

class OpenAIService {
  constructor(config = {}) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async analyzeFeedback(messages) {
    try {
      console.log('\n=== Starting OpenAI Analysis ===');
      console.log('Total messages:', messages.length);
      
      // Log message statistics
      const stats = messages.reduce((acc, msg) => {
        const threadKey = msg.thread_ts || msg.ts;
        if (!acc.threads[threadKey]) {
          acc.threads[threadKey] = {
            messages: 0,
            text: msg.text?.slice(0, 100)
          };
        }
        acc.threads[threadKey].messages++;
        return acc;
      }, { threads: {} });
      
      console.log('\nThread Statistics:');
      Object.entries(stats.threads).forEach(([key, data]) => {
        console.log(`Thread ${key}:`, {
          messageCount: data.messages,
          preview: data.text
        });
      });

      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-2024-11-20",
        messages: [
          {
            role: "system",
            content: `You are a software development project manager analyzing conversations.
              Follow these steps exactly:
              
              1. First pass - Identify all potential issues:
                - Look for technical problems, bugs, feature requests
                - Look for user complaints or difficulties
                - Look for process inefficiencies
                - Flag ALL potential issues
              
              2. Second pass - For each potential issue:
                - Verify it has clear technical impact
                - Verify it has specific user/business impact
                - Verify it has actionable solution
                - Keep if ANY of these are true
              
              3. Final pass - Create tickets:
                - Create separate tickets for distinct problems
                - Never combine different issues
                - Include all relevant context
                - Format exactly as specified
              
              Return a JSON object with this exact structure:
              {
                "feedback": [
                  {
                    "title": "Clear problem statement",
                    "type": "bug|improvement|feature",
                    "priority": "high|medium|low",
                    "user_impact": "Specific business/user effect",
                    "current_behavior": "Precise current state",
                    "expected_behavior": "Clear desired outcome"
                  }
                ]
              }`
          },
          {
            role: "user",
            content: JSON.stringify(messages)
          }
        ],
        temperature: 0,
        response_format: { type: "json_object" }
      });

      console.log('\nOpenAI Response:', {
        model: process.env.OPENAI_MODEL,
        temperature: 0,
        responseLength: response.choices[0].message.content.length
      });

      // Log the raw response for debugging
      console.log('\nRaw Response:', response.choices[0].message.content);

      const result = JSON.parse(response.choices[0].message.content);
      if (!result.feedback || !Array.isArray(result.feedback)) {
        throw new Error('Invalid response format from OpenAI');
      }

      console.log('\nAnalysis Results:', {
        totalThreads: Object.keys(stats.threads).length,
        identifiedIssues: result.feedback.length,
        issueTypes: result.feedback.reduce((acc, issue) => {
          acc[issue.type] = (acc[issue.type] || 0) + 1;
          return acc;
        }, {})
      });

      return result.feedback.sort((a, b) => a.title.localeCompare(b.title));

    } catch (error) {
      console.error('Error analyzing feedback:', error);
      // Log more details about JSON parsing errors
      if (error.message.includes('JSON')) {
        console.error('JSON Parse Error Details:', {
          error: error.message,
          responsePreview: response?.choices[0]?.message?.content?.slice(0, 200)
        });
      }
      if (error.message.includes('JSON')) {
        throw new Error('Failed to process feedback. Please try again.');
      }
      throw error;
    }
  }
}

module.exports = { OpenAIService };