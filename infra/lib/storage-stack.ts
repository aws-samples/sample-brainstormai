import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class StorageStack extends cdk.Stack {
  public readonly assetsBucket: s3.Bucket;
  public readonly notebooksTable: dynamodb.Table;
  public readonly sourcesTable: dynamodb.Table;
  public readonly jobsTable: dynamodb.Table;
  public readonly artifactsTable: dynamodb.Table;
  public readonly wsConnectionsTable: dynamodb.Table;
  public readonly podcastSessionsTable: dynamodb.Table;
  public readonly vpc: ec2.Vpc;
  public readonly userJobCountTable: dynamodb.Table;
  public readonly vectorsBucketName: string = "brainstormai-vectors";

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC (2 AZs, private subnets for ECS) ──
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ── S3 ──
    this.assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `brainstormai-assets-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: "expire-temp-audio",
          prefix: "audio/",
          expiration: cdk.Duration.days(7),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── DynamoDB Tables ──
    this.notebooksTable = new dynamodb.Table(this, "NotebooksTable", {
      tableName: "brainstormai-notebooks",
      partitionKey: { name: "notebookId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.notebooksTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    this.sourcesTable = new dynamodb.Table(this, "SourcesTable", {
      tableName: "brainstormai-sources",
      partitionKey: { name: "sourceId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.sourcesTable.addGlobalSecondaryIndex({
      indexName: "notebookId-index",
      partitionKey: { name: "notebookId", type: dynamodb.AttributeType.STRING },
    });

    this.jobsTable = new dynamodb.Table(this, "JobsTable", {
      tableName: "brainstormai-jobs",
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: "notebookId-index",
      partitionKey: { name: "notebookId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    // Atomic running_jobs counter lives on user item in this table
    this.userJobCountTable = new dynamodb.Table(this, "UserJobCountTable", {
      tableName: "brainstormai-user-job-counts",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.artifactsTable = new dynamodb.Table(this, "ArtifactsTable", {
      tableName: "brainstormai-artifacts",
      partitionKey: { name: "artifactId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.artifactsTable.addGlobalSecondaryIndex({
      indexName: "notebookId-index",
      partitionKey: { name: "notebookId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    });

    this.wsConnectionsTable = new dynamodb.Table(this, "WsConnectionsTable", {
      tableName: "brainstormai-ws-connections",
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.podcastSessionsTable = new dynamodb.Table(this, "PodcastSessionsTable", {
      tableName: "brainstormai-podcast-sessions",
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.podcastSessionsTable.addGlobalSecondaryIndex({
      indexName: "connectionId-index",
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
    });

    // ── S3 Vectors bucket (one index per notebook, cosine/float32) ──
    new cdk.CfnResource(this, "VectorsBucket", {
      type: "AWS::S3Vectors::VectorBucket",
      properties: {
        VectorBucketName: this.vectorsBucketName,
      },
    });

    new cdk.CfnOutput(this, "AssetsBucketName", { value: this.assetsBucket.bucketName });
    new cdk.CfnOutput(this, "VectorsBucketName", { value: this.vectorsBucketName });
  }
}
