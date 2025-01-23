const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

class CloudWatchService {
  constructor() {
    this.isLocalMode = process.env.AWS_ACCESS_KEY_ID === 'local';
    console.log(`🔧 CloudWatch Service running in ${this.isLocalMode ? 'local' : 'AWS'} mode`);
    console.log('Debug: AWS_ACCESS_KEY_ID =', process.env.AWS_ACCESS_KEY_ID);
    
    if (!this.isLocalMode) {
      this.client = new CloudWatchClient({
        region: process.env.AWS_REGION || 'us-west-2',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
    }
  }

  async recordMetric(name, value, unit = 'Count', dimensions = []) {
    if (this.isLocalMode) {
      console.log('📊 [Local] Recording metric:', {
        name,
        value,
        unit,
        dimensions,
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      const command = new PutMetricDataCommand({
        Namespace: 'FeedbackCollector',
        MetricData: [{
          MetricName: name,
          Value: value,
          Unit: unit,
          Dimensions: dimensions,
          Timestamp: new Date()
        }]
      });
      await this.client.send(command);
    } catch (error) {
      if (this.isLocalMode) {
        console.log('⚠️ [Local] Error ignored in local mode');
      } else {
        console.error('Error recording metric:', error);
      }
    }
  }

  // Helper methods for common metrics
  async recordSessionCreation(userId) {
    await this.recordMetric('SessionCreations', 1, 'Count', [
      { Name: 'UserId', Value: userId }
    ]);
  }

  async recordFeedbackCollection(sessionId, count) {
    await this.recordMetric('FeedbackItemsCollected', count, 'Count', [
      { Name: 'SessionId', Value: sessionId }
    ]);
  }

  async recordDuplicateDetection(sessionId, similarityScore) {
    await this.recordMetric('DuplicatesDetected', 1, 'Count', [
      { Name: 'SessionId', Value: sessionId },
      { Name: 'SimilarityScore', Value: similarityScore.toString() }
    ]);
  }

  async recordJiraTicketCreation(sessionId) {
    await this.recordMetric('JiraTicketsCreated', 1, 'Count', [
      { Name: 'SessionId', Value: sessionId }
    ]);
  }

  async recordOperationLatency(operationName, durationMs) {
    await this.recordMetric(
      `${operationName}Latency`,
      durationMs,
      'Milliseconds'
    );
  }

  async recordProjectKeySet(channelId, userId) {
    await this.recordMetric('ProjectKeySettings', 1, 'Count', [
      { Name: 'ChannelId', Value: channelId },
      { Name: 'UserId', Value: userId }
    ]);
  }

  async recordInvalidProjectKey(channelId, userId, attemptedKey) {
    await this.recordMetric('InvalidProjectKeys', 1, 'Count', [
      { Name: 'ChannelId', Value: channelId },
      { Name: 'UserId', Value: userId },
      { Name: 'AttemptedKey', Value: attemptedKey }
    ]);
  }
}

module.exports = new CloudWatchService(); 