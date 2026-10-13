'use strict';

const Item = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Paracetamol 500mg' },
    description: { type: 'string', example: 'Strip of 10 tablets' },
    price: { type: 'number', example: 25.5 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const ItemInput = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', example: 'Paracetamol 500mg' },
    description: { type: 'string', example: 'Strip of 10 tablets' },
    price: { type: 'number', example: 25.5 },
  },
};

const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const notFound = { description: 'Item not found' };

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'NetCheck API',
    version: '1.0.0',
    description:
      'Throwaway CRUD API for testing the MediXpert VPC. Items are kept in memory and lost on restart. ' +
      'The Network endpoints show which subnet the instance is in and whether it can reach the internet through the NAT gateway.',
  },
  servers: [{ url: '/api/v1' }],
  tags: [{ name: 'Health' }, { name: 'Items' }, { name: 'Network' }],
  components: { schemas: { Item, ItemInput } },
  paths: {
    '/health': {
      get: { tags: ['Health'], summary: 'Liveness check (use as the ALB / target group health check)', responses: { 200: { description: 'OK' } } },
    },
    '/items': {
      get: {
        tags: ['Items'],
        summary: 'List items',
        responses: { 200: { description: 'All items', content: json({ type: 'array', items: ref('Item') }) } },
      },
      post: {
        tags: ['Items'],
        summary: 'Create an item',
        requestBody: { required: true, content: json(ref('ItemInput')) },
        responses: { 201: { description: 'Created', content: json(ref('Item')) }, 400: { description: 'Validation error' } },
      },
    },
    '/items/{id}': {
      parameters: [idParam],
      get: {
        tags: ['Items'],
        summary: 'Get an item',
        responses: { 200: { description: 'The item', content: json(ref('Item')) }, 404: notFound },
      },
      put: {
        tags: ['Items'],
        summary: 'Update an item (partial updates allowed)',
        requestBody: { required: true, content: json({ ...ItemInput, required: [] }) },
        responses: { 200: { description: 'Updated', content: json(ref('Item')) }, 400: { description: 'Validation error' }, 404: notFound },
      },
      delete: {
        tags: ['Items'],
        summary: 'Delete an item',
        responses: { 204: { description: 'Deleted' }, 404: notFound },
      },
    },
    '/network/instance': {
      get: {
        tags: ['Network'],
        summary: 'VPC, subnet, AZ, private/public IP and security groups of this EC2 instance (from IMDSv2)',
        responses: { 200: { description: 'Instance network info' }, 502: { description: 'Not running on EC2' } },
      },
    },
    '/network/egress': {
      get: {
        tags: ['Network'],
        summary: 'Outbound internet test. App subnet: returns the NAT IP. Data subnet: times out.',
        responses: { 200: { description: 'Internet reachable' }, 504: { description: 'No outbound internet' } },
      },
    },
    '/network/external-sample': {
      get: {
        tags: ['Network'],
        summary: 'Call a public third-party JSON API (jsonplaceholder.typicode.com)',
        responses: { 200: { description: 'Upstream response' }, 504: { description: 'Upstream unreachable' } },
      },
    },
    '/network/dns': {
      get: {
        tags: ['Network'],
        summary: 'Resolve a hostname with the VPC DNS resolver',
        parameters: [{ name: 'host', in: 'query', required: true, schema: { type: 'string', example: 'google.com' } }],
        responses: { 200: { description: 'Resolved addresses' }, 502: { description: 'Lookup failed' } },
      },
    },
    '/network/tcp': {
      get: {
        tags: ['Network'],
        summary: 'TCP connect test, e.g. RDS :5432 or ElastiCache :6379, to verify security group rules',
        parameters: [
          { name: 'host', in: 'query', required: true, schema: { type: 'string', example: 'google.com' } },
          { name: 'port', in: 'query', required: true, schema: { type: 'integer', example: 443 } },
        ],
        responses: {
          200: { description: 'Port reachable' },
          502: { description: 'Connection refused / DNS error' },
          504: { description: 'Timed out (security group or route blocking)' },
          403: { description: 'Disabled via ENABLE_TCP_CHECK=false' },
        },
      },
    },
  },
};
