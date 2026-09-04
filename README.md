# AgentCore Gateway + API Gateway Targets Demo

CDK (TypeScript) demo of two Amazon Bedrock AgentCore Gateway target types,
each reaching an API Gateway backend through a VPC instead of over the
public internet — matching the pattern in the AWS blog post
["Configuring Amazon Bedrock AgentCore Gateway for secure access to private resources"](https://aws.amazon.com/blogs/machine-learning/configuring-amazon-bedrock-agentcore-gateway-for-secure-access-to-private-resources/).

- **Books path** — REST API target (`addApiGatewayTarget`) fronting a
  `REGIONAL` (public-type) API Gateway.
- **Films path** — OpenAPI target (`addOpenApiTarget`) fronting a genuinely
  `PRIVATE`-type API Gateway.

Both paths route the AgentCore Gateway's outbound calls through the same
shared VPC and `execute-api` interface VPC endpoint — neither ever touches
the public internet — but they get there via different mechanisms, shown
side by side below.

## What this deploys

Shared:
- A VPC with an isolated subnet and an interface VPC endpoint for
  `execute-api`, reused by both the Books and Films paths.
- An AgentCore `Gateway` (`agentcore.Gateway`) with one target per path.
- A bare `agentcore.CfnHarness` — default create only, no Strands code, no
  tools/skills/memory wiring.

**Books path (REST API target, public-type API Gateway):**
- A Lambda (`src/books-handler.ts`) returning a small list of Norwegian
  books as `{ books: [...] }`.
- An API Gateway (`GET /books`) in front of the Lambda. Its endpoint type
  is `REGIONAL` — API Gateway's "public" type — because the AgentCore
  Gateway's `mcp.apiGateway` target type only supports public endpoint
  types. Access is still locked down: a hand-written resource policy
  denies `execute-api:Invoke` from anywhere except the VPC endpoint above.
- The target (`gateway.addApiGatewayTarget()`) exposes `GET /books` as a
  tool. Its `privateEndpoint.managedVpcResource` is set via the L1 escape
  hatch (a typed property, no `addPropertyOverride` needed) so the
  Gateway routes its calls through the VPC and out via the VPC endpoint,
  rather than over the public internet. This is what actually makes the
  access "private" end-to-end, even though the API's endpoint type is
  REGIONAL.

**Films path (OpenAPI target, genuinely private API Gateway):**
- A Lambda (`src/films-handler.ts`) returning a small list of Norwegian
  films as `{ films: [...] }`.
- An API Gateway (`GET /films`) in front of the Lambda, with endpoint type
  `PRIVATE` — API Gateway's genuinely-private type: it has no public DNS
  name at all. The shared `execute-api` VPC endpoint from above is
  explicitly associated with it via `endpointConfiguration.vpcEndpoints`
  (a single VPC endpoint can be associated with multiple private APIs).
  Access is locked down via `grantInvokeFromVpcEndpointsOnly()` — a CDK
  helper that builds the same deny/allow resource policy shape as the
  Books API's hand-written one.
- `addOpenApiTarget()` has no VPC-routing field, and unlike
  `addApiGatewayTarget()` it also has no `restApi`/`stage` field — the
  backend host is defined entirely by the OpenAPI document's own
  `servers[].url`. Because the VPC endpoint is associated with this
  `PRIVATE` API, AWS auto-generates a VPCE-specific Route 53 alias
  (`https://{restApiId}-{vpceId}.execute-api.{region}.amazonaws.com/{stage}`),
  which is what the inline OpenAPI schema's `servers[].url` points to.
  The same `privateEndpoint.managedVpcResource` L1 override used for the
  Books target is applied here too, on the OpenAPI-type target.

## REST API target vs. OpenAPI target

|                        | Books (REST API target)                | Films (OpenAPI target)                     |
|------------------------|------------------------------------------|---------------------------------------------|
| API Gateway type       | `REGIONAL` (public)                     | `PRIVATE`                                    |
| Why that type          | `ApiGatewayTargetConfiguration` requires a public endpoint type | No such constraint — OpenAPI target doesn't touch the API Gateway resource at all |
| Access control         | Hand-written resource policy scoped to the VPC endpoint | `grantInvokeFromVpcEndpointsOnly()` + VPC endpoint association |
| Backend routing        | `restApi` prop + `privateEndpoint.managedVpcResource` (L1) | `servers[].url` in the OpenAPI schema (VPCE alias) + `privateEndpoint.managedVpcResource` (L1) |
| Outbound auth to backend | IAM (SigV4)                           | API Key / OAuth (not IAM)                    |

## Deploy

```bash
npm install
npx cdk synth      # validate the stack synthesizes
npx cdk deploy      # creates real AWS resources
```

## Smoke test

1. Confirm both API Gateway stages are actually deployed — a missing
   stage deployment was the root cause of an earlier empty-content bug:
   ```bash
   aws apigateway get-stages --rest-api-id <BooksApi id from CfnOutput/console>
   aws apigateway get-stages --rest-api-id <FilmsApi id from CfnOutput/console>
   ```
2. Invoke the Gateway's tools for `GET /books` and `GET /films` (via
   awscurl or an MCP client — see `test-agentcore-gateway.sh` in the
   `pm-server-side/server-side` repo root for the request shape) and
   confirm the books/films come back non-empty.
3. Confirm the harness reaches `CREATE_COMPLETE`:
   ```bash
   aws bedrock-agentcore-control get-harness --harness-id <id>
   ```

## Teardown

```bash
npx cdk destroy
```
