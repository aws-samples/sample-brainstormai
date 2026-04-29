import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
  // Kept for cross-stack reference compatibility during migration; remove after ComputeStack is deployed without DB refs
  public readonly dbSecret: secretsmanager.Secret;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
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

    // ── RDS PostgreSQL (retained; kept active until ComputeStack no longer references it) ──
    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: this.vpc,
      description: "RDS PostgreSQL access",
    });

    this.dbSecret = new secretsmanager.Secret(this, "DbSecret", {
      secretName: "brainstormai/db",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "brainstorm" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    const dbInstance = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: "brainstormai",
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dbEndpoint = dbInstance.dbInstanceEndpointAddress;
    this.dbPort = dbInstance.dbInstanceEndpointPort;

    // ── S3 Vectors bucket (one index per notebook, cosine/float32) ──
    new cdk.CfnResource(this, "VectorsBucket", {
      type: "AWS::S3Vectors::VectorBucket",
      properties: {
        VectorBucketName: this.vectorsBucketName,
      },
    });

    new cdk.CfnOutput(this, "AssetsBucketName", { value: this.assetsBucket.bucketName });
    new cdk.CfnOutput(this, "VectorsBucketName", { value: this.vectorsBucketName });
    new cdk.CfnOutput(this, "DbEndpoint", { value: this.dbEndpoint });
  }
}
