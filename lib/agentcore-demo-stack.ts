import * as cdk from "aws-cdk-lib"
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore"
import * as apigateway from "aws-cdk-lib/aws-apigateway"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as lambda from "aws-cdk-lib/aws-lambda"
import type { Construct } from "constructs"
import * as path from "path"

export class AgentcoreDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // A small VPC for the execute-api interface endpoint. The AgentCore Gateway
    // routes into this VPC (via privateEndpoint.managedVpcResource below) instead
    // of calling the API Gateway over the public internet.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })

    const vpcEndpointSg = new ec2.SecurityGroup(this, "VpcEndpointSg", {
      vpc,
      description: "Allows inbound HTTPS to the execute-api VPC endpoint",
      allowAllOutbound: true,
    })
    vpcEndpointSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443))

    const executeApiEndpoint = vpc.addInterfaceEndpoint("ExecuteApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [vpcEndpointSg],
      privateDnsEnabled: true,
    })

    const booksFunction = new lambda.Function(this, "BooksFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "books-handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "src")),
    })

    // REGIONAL is API Gateway's "public" endpoint type (as opposed to PRIVATE).
    // AgentCore Gateway's mcp.apiGateway target only supports public endpoint
    // types, so access is instead restricted here via a resource policy that
    // only allows requests arriving through our VPC endpoint. The AgentCore
    // Gateway target routes through that same VPC endpoint (via
    // privateEndpoint.managedVpcResource below), so it never touches the
    // public internet even though the API's endpoint type is "public".
    const booksApi = new apigateway.RestApi(this, "BooksApi", {
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              StringNotEquals: { "aws:SourceVpce": executeApiEndpoint.vpcEndpointId },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
          }),
        ],
      }),
      deploy: true,
      deployOptions: { stageName: "sit" },
    })

    const books = booksApi.root.addResource("books")
    books.addMethod("GET", new apigateway.LambdaIntegration(booksFunction))

    const gateway = new agentcore.Gateway(this, "Gateway", {
      gatewayName: "agentcore-demo-books-gateway",
    })

    const target = gateway.addApiGatewayTarget("BooksTarget", {
      restApi: booksApi,
      apiGatewayToolConfiguration: {
        toolFilters: [{ filterPath: "/books", methods: [agentcore.ApiGatewayHttpMethod.GET] }],
      },
    })

    // The L2 addApiGatewayTarget() has no VPC-routing option, so we reach into
    // the generated L1 to set privateEndpoint directly — a typed property, no
    // addPropertyOverride escape hatch required.
    const cfnTarget = target.node.defaultChild as agentcore.CfnGatewayTarget
    cfnTarget.privateEndpoint = {
      managedVpcResource: {
        vpcIdentifier: vpc.vpcId,
        subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
        securityGroupIds: [vpcEndpointSg.securityGroupId],
        endpointIpAddressType: "IPV4",
      },
    }

    const filmsFunction = new lambda.Function(this, "FilmsFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "films-handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "src")),
    })

    // PRIVATE is API Gateway's genuinely-private endpoint type: it has no
    // public DNS name at all, and is only reachable from VPCs whose
    // endpoint is explicitly associated with it via vpcEndpoints below.
    // That association is also what makes AWS generate the VPCE-specific
    // Route 53 alias used as this API's servers.url in the OpenAPI schema
    // further down. Reuses the same execute-api VPC endpoint as the books
    // API — a single endpoint can be associated with multiple private APIs.
    const filmsApi = new apigateway.RestApi(this, "FilmsApi", {
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [executeApiEndpoint],
      },
      deploy: true,
      deployOptions: { stageName: "sit" },
    })
    filmsApi.grantInvokeFromVpcEndpointsOnly([executeApiEndpoint])

    const films = filmsApi.root.addResource("films")
    films.addMethod("GET", new apigateway.LambdaIntegration(filmsFunction))

    // addOpenApiTarget() has no VPC-routing option either, and unlike
    // addApiGatewayTarget() it also has no restApi/stage field — the
    // backend host is defined entirely by this schema's servers.url. We
    // point it at the VPCE-specific alias so calls only ever traverse the
    // private API via our VPC endpoint, never the public internet.
    const filmsApiUrl = `https://${filmsApi.restApiId}-${executeApiEndpoint.vpcEndpointId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/sit`

    const filmsApiSchema = agentcore.ApiSchema.fromInline(
      JSON.stringify({
        openapi: "3.0.1",
        info: { title: "Films API", version: "1.0.0" },
        servers: [{ url: filmsApiUrl }],
        paths: {
          "/films": {
            get: {
              operationId: "getFilms",
              summary: "List Norwegian films",
              responses: {
                "200": {
                  description: "A list of films",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          films: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                id: { type: "integer" },
                                title: { type: "string" },
                                director: { type: "string" },
                                year: { type: "integer" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    )

    const filmsTarget = gateway.addOpenApiTarget("FilmsTarget", {
      apiSchema: filmsApiSchema,
      // OpenAPI targets don't sign outbound requests by default. Without an
      // explicit IAM role credential provider (service/region), the gateway
      // can't SigV4-sign the call to the private API and it fails at runtime.
      credentialProviderConfigurations: [
        agentcore.GatewayCredentialProvider.fromIamRole({
          service: "execute-api",
          region: cdk.Stack.of(this).region,
        }),
      ],
    })

    const cfnFilmsTarget = filmsTarget.node.defaultChild as agentcore.CfnGatewayTarget
    cfnFilmsTarget.privateEndpoint = {
      managedVpcResource: {
        vpcIdentifier: vpc.vpcId,
        subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
        securityGroupIds: [vpcEndpointSg.securityGroupId],
        endpointIpAddressType: "IPV4",
      },
    }

    const harnessRole = new iam.Role(this, "HarnessRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    })
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
      }),
    )

    // Bare default harness: no Strands code, no tools/skills/memory wiring —
    // just the required create-time fields.
    new agentcore.CfnHarness(this, "Harness", {
      harnessName: "AgentcoreDemoHarness",
      executionRoleArn: harnessRole.roleArn,
      model: {
        bedrockModelConfig: {
          modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        },
      },
    })

    new cdk.CfnOutput(this, "BooksApiUrl", { value: booksApi.url })
    // filmsApi.url is the standard (unreachable outside the VPC) hostname —
    // included for reference only. The Gateway target actually calls the
    // VPCE-specific alias baked into filmsApiUrl above.
    new cdk.CfnOutput(this, "FilmsApiUrl", { value: filmsApi.url })
    new cdk.CfnOutput(this, "FilmsApiVpceUrl", { value: filmsApiUrl })
    new cdk.CfnOutput(this, "GatewayId", { value: gateway.gatewayId })
    new cdk.CfnOutput(this, "GatewayArn", { value: gateway.gatewayArn })
  }
}
