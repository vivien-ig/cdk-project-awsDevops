import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class CdkProjectAwsDevopsStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const context = this.node.tryGetContext.bind(this.node);

    const vpcCidr = context('vpcCidr') ?? '10.20.0.0/16';
    const instanceType = context('instanceType') ?? 't3.micro';
    const desiredCapacity = Number(context('desiredCapacity') ?? 2);
    const minCapacity = Number(context('minCapacity') ?? 1);
    const maxCapacity = Number(context('maxCapacity') ?? 4);
    const dbStorage = Number(context('dbStorage') ?? 20);
    const natGateways = Number(context('natGateways') ?? 1);
    const dbEngine = String(context('dbEngine') ?? 'postgres');

    if (dbEngine !== 'postgres') {
      throw new Error('This starter implementation supports PostgreSQL only.');
    }

    if (
      minCapacity < 1 ||
      desiredCapacity < minCapacity ||
      desiredCapacity > maxCapacity
    ) {
      throw new Error(
        'Capacity must satisfy minCapacity <= desiredCapacity <= maxCapacity.',
      );
    }

    // 1. Network: public, private application, and isolated database subnets.
    const vpc = new ec2.Vpc(this, 'ApplicationVpc', {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 2,
      natGateways,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // 2. Security groups.
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Public HTTP access to the load balancer',
      allowAllOutbound: true,
    });

    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow public HTTP',
    );

    const appSg = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: 'Application traffic only from the ALB',
      allowAllOutbound: true,
    });

    appSg.addIngressRule(
      albSg,
      ec2.Port.tcp(80),
      'Allow HTTP only from the ALB',
    );

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'PostgreSQL access only from application instances',
      allowAllOutbound: false,
    });

    dbSg.addIngressRule(
      appSg,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL only from the application tier',
    );

    // 3. EC2 Auto Scaling Group.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y httpd',
      'mkdir -p /var/www/html',
      'echo "<h1>Secure Scalable AWS Application</h1>" > /var/www/html/index.html',
      'echo "OK" > /var/www/html/health',
      'systemctl enable httpd',
      'systemctl start httpd',
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'ApplicationAsg', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: appSg,
      userData,
      minCapacity,
      maxCapacity,
      desiredCapacity,
      healthCheck: autoscaling.HealthCheck.elb({
        grace: cdk.Duration.minutes(5),
      }),
    });

    asg.scaleOnCpuUtilization('CpuTargetTracking', {
      targetUtilizationPercent: 50,
      cooldown: cdk.Duration.minutes(5),
    });

    // 4. Public Application Load Balancer.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationAlb', {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: albSg,
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: false,
    });

    listener.addTargets('ApplicationTargets', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });

    // 5. Private PostgreSQL RDS with generated credentials in Secrets Manager.
    const database = new rds.DatabaseInstance(this, 'ApplicationDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: new ec2.InstanceType('t3.micro'),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSg],
      allocatedStorage: dbStorage,
      storageType: rds.StorageType.GP2,
      multiAz: false,
      publiclyAccessible: false,
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
      databaseName: 'appdb',
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      backupRetention: cdk.Duration.days(1),
    });

    // Outputs for deployment verification.
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'LoadBalancerUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
    });

    new cdk.CfnOutput(this, 'AutoScalingGroupName', {
      value: asg.autoScalingGroupName,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: database.secret!.secretArn,
    });
  }
}
