// Lambda handler backing the private API Gateway's GET /books route.
// Ported from the working test-books Lambda (Downloads/test-books-lambda-books-field.js):
// the response must be a top-level "books" field for the OpenAPI schema exposed
// through the AgentCore Gateway REST API target to match.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda"

interface Book {
  id: number
  title: string
  author: string
  year: number
}

const books: Book[] = [
  { id: 1, title: "Sult", author: "Knut Hamsun", year: 1890 },
  { id: 2, title: "Naiv.Super", author: "Erlend Loe", year: 1996 },
  { id: 3, title: "Bienes historie", author: "Maja Lunde", year: 2015 },
]

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log("Received event:", JSON.stringify(event))

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books }),
  }
}
