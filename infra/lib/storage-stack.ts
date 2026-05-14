import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

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
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      bucketName: `brainstormai-access-logs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `brainstormai-assets-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "assets-bucket/",
      lifecycleRules: [
        {
          id: "expire-temp-audio",
          prefix: "audio/",
          expiration: cdk.Duration.days(30),
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

    // Helper to attach Checkov skip metadata to DynamoDB tables.
    // CKV_AWS_119 / DYNAMODB_TABLE_ENCRYPTED_KMS: DynamoDB uses AWS-owned CMK encryption at rest
    // by default; KMS CMK adds cost and operational overhead not warranted for a sample application.
    // CKV_AWS_28 / DDB3: PITR disabled for sample app to reduce cost; production deployments should enable it.
    const skipDynamoCheckov = (table: dynamodb.Table) => {
      (table.node.defaultChild as cdk.CfnResource).addMetadata("checkov", {
        skip: [
          { id: "CKV_AWS_119", comment: "DynamoDB AWS-owned CMK encryption is sufficient for sample app; KMS CMK not required." },
          { id: "CKV_AWS_28",  comment: "PITR disabled for sample app to reduce cost; enable in production." },
        ],
      });
    };

    // ── DynamoDB Tables ──
    this.notebooksTable = new dynamodb.Table(this, "NotebooksTable", {
      tableName: "brainstormai-notebooks",
      partitionKey: { name: "notebookId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    skipDynamoCheckov(this.notebooksTable);
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
    skipDynamoCheckov(this.sourcesTable);
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
    skipDynamoCheckov(this.jobsTable);
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
    skipDynamoCheckov(this.userJobCountTable);

    this.artifactsTable = new dynamodb.Table(this, "ArtifactsTable", {
      tableName: "brainstormai-artifacts",
      partitionKey: { name: "artifactId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    skipDynamoCheckov(this.artifactsTable);
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
    skipDynamoCheckov(this.wsConnectionsTable);

    this.podcastSessionsTable = new dynamodb.Table(this, "PodcastSessionsTable", {
      tableName: "brainstormai-podcast-sessions",
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    skipDynamoCheckov(this.podcastSessionsTable);
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

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      { id: "AwsSolutions-S1", reason: "Access logs bucket does not need its own access logs — this would cause infinite recursion." },
    ]);

    NagSuppressions.addResourceSuppressions(this.vpc, [
      { id: "AwsSolutions-VPC7", reason: "VPC Flow Logs omitted for sample application to reduce cost and operational overhead. Production deployments should enable flow logs." },
    ]);

    NagSuppressions.addResourceSuppressions(dbInstance, [
      { id: "AwsSolutions-RDS3", reason: "Multi-AZ not required for sample application. Production deployments should enable multi-AZ for high availability." },
      { id: "AwsSolutions-RDS11", reason: "Default PostgreSQL port used for simplicity in this sample. Production deployments should use a non-default port." },
    ]);

    NagSuppressions.addResourceSuppressions(this.dbSecret, [
      { id: "AwsSolutions-SMG4", reason: "Automatic secret rotation not configured for sample application. Production deployments should enable rotation." },
    ]);

    // Suppress IAM wildcard warnings on CDK-generated grant policies (index/* on DynamoDB is required for GSI access)
    NagSuppressions.addStackSuppressions(this, [
      { id: "AwsSolutions-IAM5", reason: "CDK grantReadWriteData adds index/* wildcards for DynamoDB GSI access — required for query operations on global secondary indexes." },
      { id: "AwsSolutions-DDB3", reason: "Point-in-time recovery not enabled for this sample application. Production deployments should enable PITR on all tables." },
    ]);
  }
}
