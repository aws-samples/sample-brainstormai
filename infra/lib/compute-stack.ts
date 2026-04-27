import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";

interface ComputeStackProps extends cdk.StackProps {
  wsCallbackUrl: string;
  assetsBucket: s3.Bucket;
  notebooksTable: dynamodb.Table;
  sourcesTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  artifactsTable: dynamodb.Table;
  wsConnectionsTable: dynamodb.Table;
  podcastSessionsTable: dynamodb.Table;
  userJobCountTable: dynamodb.Table;
  dbSecret: secretsmanager.Secret;
  dbEndpoint: string;
  dbPort: string;
  dbSecurityGroup: ec2.SecurityGroup;
  vpc: ec2.Vpc;
}

export class ComputeStack extends cdk.Stack {
  public readonly ingestionQueue: sqs.Queue;
  public readonly podcastQueue: sqs.Queue;
  public readonly mindmapQueue: sqs.Queue;
  public readonly quizQueue: sqs.Queue;
  public readonly summaryQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // ── SQS Queues (with DLQs) ──
    const makeDlq = (name: string) =>
      new sqs.Queue(this, `${name}Dlq`, {
        queueName: `brainstormai-${name}-dlq`,
        retentionPeriod: cdk.Duration.days(14),
      });

    const makeQueue = (name: string, dlq: sqs.Queue) =>
      new sqs.Queue(this, `${name}Queue`, {
        queueName: `brainstormai-${name}`,
        visibilityTimeout: cdk.Duration.minutes(15),
        retentionPeriod: cdk.Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });

    this.ingestionQueue = makeQueue("ingestion", makeDlq("ingestion"));
    this.podcastQueue = makeQueue("podcast", makeDlq("podcast"));
    this.mindmapQueue = makeQueue("mindmap", makeDlq("mindmap"));
    this.quizQueue = makeQueue("quiz", makeDlq("quiz"));
    this.summaryQueue = makeQueue("summary", makeDlq("summary"));

    // ── ECS Cluster ──
    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "brainstormai",
      vpc: props.vpc,
      containerInsights: true,
    });

    // ── Worker Task Role ──
    const workerRole = new iam.Role(this, "WorkerRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });

    props.assetsBucket.grantReadWrite(workerRole);
    props.notebooksTable.grantReadWriteData(workerRole);
    props.sourcesTable.grantReadWriteData(workerRole);
    props.jobsTable.grantReadWriteData(workerRole);
    props.artifactsTable.grantReadWriteData(workerRole);
    props.wsConnectionsTable.grantReadWriteData(workerRole);
    props.podcastSessionsTable.grantReadWriteData(workerRole);
    props.userJobCountTable.grantReadWriteData(workerRole);
    props.dbSecret.grantRead(workerRole);
    this.ingestionQueue.grantConsumeMessages(workerRole);
    this.podcastQueue.grantConsumeMessages(workerRole);
    this.mindmapQueue.grantConsumeMessages(workerRole);
    this.quizQueue.grantConsumeMessages(workerRole);
    this.summaryQueue.grantConsumeMessages(workerRole);

    workerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "polly:SynthesizeSpeech",
          "textract:DetectDocumentText",
          "textract:AnalyzeDocument",
          "execute-api:ManageConnections",
          "cloudwatch:PutMetricData",
        ],
        resources: ["*"],
      })
    );

    const workerEnv = {
      AWS_REGION: this.region,
      S3_BUCKET: props.assetsBucket.bucketName,
      NOTEBOOKS_TABLE: props.notebooksTable.tableName,
      SOURCES_TABLE: props.sourcesTable.tableName,
      JOBS_TABLE: props.jobsTable.tableName,
      ARTIFACTS_TABLE: props.artifactsTable.tableName,
      WS_CONNECTIONS_TABLE: props.wsConnectionsTable.tableName,
      PODCAST_SESSIONS_TABLE: props.podcastSessionsTable.tableName,
      DB_HOST: props.dbEndpoint,
      DB_PORT: props.dbPort,
      DB_NAME: "brainstormai",
      DB_SECRET_ARN: props.dbSecret.secretArn,
      INGESTION_QUEUE_URL: this.ingestionQueue.queueUrl,
      PODCAST_QUEUE_URL: this.podcastQueue.queueUrl,
      MINDMAP_QUEUE_URL: this.mindmapQueue.queueUrl,
      QUIZ_QUEUE_URL: this.quizQueue.queueUrl,
      SUMMARY_QUEUE_URL: this.summaryQueue.queueUrl,
      DAILY_TOKEN_LIMIT: "500000",
      WS_ENDPOINT: props.wsCallbackUrl,
    };

    // ── Ingestion Worker ──
    const ingestionTaskDef = new ecs.FargateTaskDefinition(this, "IngestionTaskDef", {
      memoryLimitMiB: 2048,
      cpu: 512,
      taskRole: workerRole,
    });
    ingestionTaskDef.addContainer("ingestion-worker", {
      image: ecs.ContainerImage.fromAsset("../backend/workers/ingestion", {
        platform: assets.Platform.LINUX_AMD64,
      }),
      environment: { ...workerEnv, QUEUE_URL: this.ingestionQueue.queueUrl },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ingestion-worker" }),
    });

    const ingestionService = new ecs.FargateService(this, "IngestionService", {
      cluster,
      taskDefinition: ingestionTaskDef,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true,
    });

    // ── Generation Worker (handles podcast, mindmap, quiz from separate queues) ──
    const generationTaskDef = new ecs.FargateTaskDefinition(this, "GenerationTaskDef", {
      memoryLimitMiB: 4096,
      cpu: 1024,
      taskRole: workerRole,
    });
    generationTaskDef.addContainer("generation-worker", {
      image: ecs.ContainerImage.fromAsset("../backend/workers/generation", {
        platform: assets.Platform.LINUX_AMD64,
      }),
      environment: workerEnv,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "generation-worker" }),
    });

    const generationService = new ecs.FargateService(this, "GenerationService", {
      cluster,
      taskDefinition: generationTaskDef,
      desiredCount: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true,
    });

    // Allow worker SGs to reach RDS on 5432
    props.dbSecurityGroup.addIngressRule(
      ingestionService.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      "Ingestion worker to RDS",
    );
    props.dbSecurityGroup.addIngressRule(
      generationService.connections.securityGroups[0],
      ec2.Port.tcp(5432),
      "Generation worker to RDS",
    );

    // ── Ingestion Auto-Scaling (1–5 tasks, driven by ingestion queue depth) ──
    const ingestionScaling = ingestionService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });
    ingestionScaling.scaleOnMetric("IngestionQueueScaling", {
      metric: this.ingestionQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { upper: 0,  change: -1 },  // scale in when queue empty
        { lower: 3,  change: +1 },  // +1 task at 3 messages
        { lower: 10, change: +2 },  // +2 more at 10 messages
      ],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(60),
    });

    // ── Generation Auto-Scaling (2–10 tasks, driven by combined queue depth) ──
    const generationScaling = generationService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });
    // Sum all 4 generation queues — each task handles all of them.
    const totalGenerationQueueDepth = new cloudwatch.MathExpression({
      expression: "m1 + m2 + m3 + m4",
      usingMetrics: {
        m1: this.podcastQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
        m2: this.mindmapQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
        m3: this.quizQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
        m4: this.summaryQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      },
    });
    generationScaling.scaleOnMetric("GenerationQueueScaling", {
      metric: totalGenerationQueueDepth,
      scalingSteps: [
        { upper: 0,  change: -1 },  // scale in when all queues empty
        { lower: 2,  change: +1 },  // +1 task at 2 queued jobs
        { lower: 6,  change: +2 },  // +2 more at 6 queued jobs
        { lower: 12, change: +3 },  // +3 more at 12 queued jobs
      ],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(120),
    });
  }
}
