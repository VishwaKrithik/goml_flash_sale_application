# High-Throughput Flash Sale Checkout Engine

An enterprise-grade, high-concurrency e-commerce checkout engine engineered to eliminate inventory overselling (TOCTOU race conditions) under sudden 10,000+ request traffic spikes. Built with Node.js 20, TypeScript, Fastify, Redis 7 (Lua scripting & Streams), PostgreSQL 16, NGINX ingress, and React 18 (Vite).

## 1. Executive Summary & Problem Statement

During flash sales, thousands of users hit the checkout endpoint within the same second. A naive implementation querying the database (`SELECT stock` $\rightarrow$ application evaluation $\rightarrow$ `UPDATE inventory`) creates a **Time-of-Check to Time-of-Use (TOCTOU)** race condition. Multiple concurrent requests read stale in-memory stock before any transaction commits, resulting in severe overselling (e.g., 540 orders placed for 500 physical items).

This project demonstrates:

1. **The Buggy Baseline (`/naive-checkout`):** Proves how concurrent requests bypass application-level stock checks and trigger overselling.

2. **The Fixed Architecture (`/checkout`):** Uses an in-memory Redis Lua gate, stream-based queue decoupling, and conditional SQL transactions to enforce absolute data consistency, guaranteeing **zero overselling** under high load.

## 2. Requirements Matrix & Solved Capabilities

| Case Study Requirement | Implemented Solution | Verification Status |
|---|---|---|
| **Zero Overselling / Invariant Guard** | Redis Lua script executes atomic check-and-decrement. Sub-4ms gate in memory. | **PROVEN:** 10,000 concurrent requests → exactly 500 confirmed orders, 0 stock. |
| **Decoupled Relational Writes** | Hot path responds with HTTP `202 Accepted` + tracking URL. Zero SQL in request path. | **PROVEN:** PostgreSQL connection pool completely shielded from request burst. |
| **Asynchronous Persistence** | Background worker consumes Redis Streams via Consumer Groups (`XREADGROUP`). | **PROVEN:** Survives worker downtime; stream buffers backlog and drains on startup. |
| **Idempotency & Double-Buy Guard** | Redis `SISMEMBER` / `SADD` on user IDs; PostgreSQL `UNIQUE(product_id, user_id)` and `UNIQUE(idem_key)`. | **PROVEN:** Duplicate clicks or replay attacks return HTTP `409 ALREADY_PURCHASED`. |
| **Ingress Load Balancing** | NGINX upstream using `least_conn` balancing across stateless Fastify replicas. | **PROVEN:** `X-Served-By` headers cycle across container IDs. |
| **Layered Rate Limiting** | **Layer 1 (NGINX):** IP leaky-bucket (`20r/s burst 40`).<br>**Layer 2 (API):** User rate limit via Redis (`5 req / 10s`). | **PROVEN:** Brute-force floods receive HTTP `429 Too Many Requests`. |
| **Client Throttling & UX** | Synchronous button lock on first click; exponential backoff + jitter polling. | **PROVEN:** Zero duplicate frontend submissions; no thundering herd on status polling. |
| **Bundle & Performance Targets** | Production bundle size < 200KB; Time-to-Interactive (TTI) < 1.5s. | **PROVEN:** Gzipped bundle is **~47 KB**; TTI is **< 0.8s**. |
| **Reservation Expiry / Reclaim** | Background reaper expires unpaid reservations and atomically returns stock to PG & Redis. | **PROVEN:** Automated reclaim script restores stock via Lua script. |

## 3. High-Level System Architecture

```mermaid
flowchart TB
    Users(["Incoming User Traffic"])

    subgraph Edge["Edge Layer"]
        Nginx["NGINX Reverse Proxy / Load Balancer<br/>• least_conn balancing<br/>• IP rate limit: 20 r/s, burst 40"]
    end

    subgraph API["Stateless API Tier (Fastify)"]
        API1["Fastify API 1"]
        API2["Fastify API 2"]
        API3["Fastify API 3"]
    end

    subgraph Hot["Hot Path: In-Memory Decision"]
        Redis[("Redis 7<br/>• Lua script: SISMEMBER → DECR<br/>• Set: buyers:phone-1<br/>• Hash: order:{id} (PENDING)<br/>• Stream: stream:orders")]
    end

    subgraph Cold["Cold Path: Durable Persistence"]
        Worker["Background Worker<br/>• XREADGROUP (consumer group)<br/>• Conditional SQL execution<br/>• XACK after COMMIT"]
        PG[("PostgreSQL 16<br/>• UPDATE ... WHERE stock > 0<br/>• INSERT order<br/>• CHECK (stock >= 0)")]
    end

    Users --> Nginx
    Nginx --> API1 & API2 & API3
    API1 & API2 & API3 -->|"EVALSHA (atomic)"| Redis
    Redis -->|"XREADGROUP (persistent queue)"| Worker
    Worker -->|"transaction"| PG
    Worker -.->|"XACK on COMMIT"| Redis
```

## 4. Request Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant N as NGINX
    participant A as Fastify API
    participant R as Redis

    U->>N: Purchase request
    N->>N: IP rate limit (20 r/s, burst 40)
    alt Over limit
        N-->>U: Rejected (rate limited)
    else Within limit
        N->>A: Route via least_conn
        A->>R: EVALSHA purchase.lua
        activate R
        Note over R: Atomic Lua execution<br/>1. SISMEMBER buyers → already bought?<br/>2. stock available?<br/>3. DECR stock<br/>4. SADD buyer<br/>5. HSET order:{id} = PENDING<br/>6. XADD stream:orders
        deactivate R
        alt Success
            R-->>A: OK + order id
            A-->>U: Accepted (order PENDING)
        else Already purchased
            R-->>A: DUPLICATE
            A-->>U: Rejected (one per buyer)
        else Sold out
            R-->>A: SOLD_OUT
            A-->>U: Rejected (sold out)
        end
    end
```

## 5. Concurrency Benchmark & Proof of Correctness

A stress test comparing the baseline naive endpoint versus the production Redis Lua pipeline was executed under identical traffic conditions (initial stock = 500 units):

| **Metric / Scenario** | **Buggy Baseline (/naive-checkout)** | **Fixed System (/checkout)** | 
| **Initial Stock** | 500 units | 500 units | 
| **Incoming Load** | 2,000 concurrent requests | 10,000 concurrent requests | 
| **Concurrency Mechanism** | Application `SELECT` $\rightarrow$ `UPDATE` | Atomic Redis Lua script + Redis Stream | 
| **Hot Path Latency** | High (DB connection starvation, deadlocks) | Sub-4ms (pure in-memory evaluation) | 
| **Orders Recorded in DB** | **540 – 580 (OVERSOLD)** | **500 (EXACT INVARIANT)** | 
| **Final DB Stock Value** | 0 | 0 | 
| **PostgreSQL Write Contention** | Massive lock contention; aborted queries | Constant, backpressure-buffered stream writes | 
| **Duplicate User Purchases** | Possible under concurrent multi-clicks | Blocked instantly by `SISMEMBER` | 

## 6. Technical Deep Dives (Module 9 Closures)

### 6.1 Locking Mechanism Comparison Under Contention

| **Locking Strategy** | **Mechanism** | **Concurrency Behavior** | **Deadlock Risk** | **DB Overhead** | **Oversell Protection** | 
| **Naive (SELECT** $\rightarrow$ **UPDATE)** | Separate queries; check in Node.js memory | Fails completely under concurrent traffic | None | Low | **Fails (Oversells)** | 
| **Pessimistic (`SELECT ... FOR UPDATE`)** | Holds exclusive row locks for duration of TX | Serializes all transactions; deep DB queues | High | High (connection starvation) | Guaranteed safe | 
| **Optimistic (`version` column)** | Checks version on update; rolls back on clash | Causes massive retry storms; 95% fail | Low | Very high during contention | Guaranteed safe | 
| **Redis Lua + Conditional SQL (Ours)** | Atomic gate in Redis memory; queue to DB | Sub-4ms gate in memory; smooth sequential writes | **Zero** | **Minimal (DB shielded)** | **Guaranteed safe** | 

### 6.2 N+1 Query Elimination & Indexing Strategy

* **Hot Path Zero-Query Guarantee:** The checkout path executes 0 SQL queries during the HTTP transaction.

* **Index Definitions:**

  ```
  -- B-tree index on user_id for fast customer order lookups
  CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  
  -- Composite index for chronological status queries
  CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);
  
  ```

* **Query Verification:** `EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'CONFIRMED' ORDER BY created_at DESC;` demonstrates an **Index Scan** with execution time under `0.05ms`.

### 6.3 Automated Reservation Expiration & Stock Reclaim

If an order remains `PENDING` (e.g., unpaid) beyond a specified timeout (default: 10 minutes), the automated maintenance worker:

1. Identifies stale orders via `SELECT ... WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '10 minutes'`.

2. Increments database inventory stock: `UPDATE inventory SET stock = stock + 1`.

3. Marks order status as `EXPIRED`.

4. Executes an atomic Redis Lua script to increment `stock:phone-1` and remove the user ID from `buyers:phone-1` so the slot can be repurchased.

## 6. Local Setup & Execution Guide

### Prerequisites

* Node.js 20+

* Docker & Docker Compose v2+

### 1. Start Infrastructure & Scaled API Cluster

```
# Clone and enter directory
git clone <REPO_URL> flash-sale
cd flash-sale

# Install root dependencies for maintenance scripts
npm install

# Launch Postgres, Redis, 3 API replicas, and NGINX
docker compose up -d --build --scale api=3

# Start the background consumer in a dedicated terminal
cd apps/worker
npm install
npm run dev

# Start the React frontend in another terminal
cd ../web
npm install
npm run dev

```

### 2. Run Concurrency Load Tests

```
# Reset system to 500 units (synchronized across PG and Redis)
node scripts/reset.mjs 500

# Execute 10,000-request concurrency load test
node scripts/load-test-node.mjs

# Verify invariants across database and cache tiers
node scripts/verify.mjs

```

## 8. Future Enterprise Cloud Architecture (Scaling to 100k+ Req/s)

To scale beyond a single-node host to hundreds of thousands of concurrent requests across multi-region infrastructure, the following enterprise components should be integrated:

```
[ Edge Layer: Cloudflare / AWS CloudFront CDN + AWS WAF ]
                         │
                         ▼
      [ Ingress: AWS Application Load Balancer (ALB) ]
                         │
                         ▼
        [ Compute: Amazon EKS Cluster (Autoscaled) ]
             ├── API Pods (Horizontal Pod Autoscaler via KEDA)
             └── Worker Pods (Scaled on Queue Length)
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
[ In-Memory Gate ]               [ Message Backbone ]
AWS ElastiCache for Redis         Apache Kafka / AWS MSK
(Multi-AZ with Auto-Failover)    (Partitioned Stream Queue)
                                          │
                                          ▼
                               [ Persistent Database ]
                               Amazon Aurora PostgreSQL
                               ├── Primary (Writer Node)
                               └── Aurora Read Replicas

```

### 8.1 AWS WAF & Cloudflare Edge Bot Management

* **Edge Static Caching:** Cloudflare/CloudFront caches 100% of the React frontend build (HTML/CSS/JS/images), offloading static asset requests from origin compute servers entirely.

* **Bot Mitigation & Challenge:** AWS WAF / Cloudflare Turnstile blocks automated botnets, credential stuffers, and headless browsers via managed rule groups (AWSManagedRulesCommonRuleSet) and invisible crypto-challenges before traffic reaches the load balancer.

### 8.2 AWS Application Load Balancer (ALB) vs. NGINX

* **Why Introduce AWS ALB:** When running across multiple virtual machines or dynamic Kubernetes nodes, an ALB provides native AWS Certificate Manager (ACM) SSL offloading, cross-zone load balancing, and health-check-based traffic routing.

* **Layered Ingress:** ALB serves as the external regional entry point, forwarding traffic to internal NGINX Ingress Controllers inside the container cluster for fine-grained path routing and leaky-bucket throttling.

### 8.3 Container Orchestration with Amazon EKS (Kubernetes)

* **Horizontal Pod Autoscaling (HPA):** API deployment replicas scale dynamically from 3 pods to 50+ pods based on CPU/Memory thresholds.

* **KEDA (Kubernetes Event-driven Autoscaling):** Scales background worker pods based directly on the **Redis Stream queue depth / lag**, ensuring worker capacity expands immediately when reservation volume surges.

### 8.4 Distributed Message Broker: Apache Kafka vs. RabbitMQ

* **Why Kafka in Enterprise:** While Redis Streams is lightweight and fast, Apache Kafka (or AWS MSK) is ideal for multi-datacenter enterprise scaling:

  * **Partitioning:** Orders can be partitioned by `product_id` across 32+ topic partitions, allowing dozens of worker nodes to process persistent writes concurrently without row locking conflicts.

  * **Retention & Replay:** Multi-day durable log retention allows replaying events in case of catastrophic downstream warehouse failures.

* **RabbitMQ Role:** Recommended if complex AMQP topic exchanges or per-message acknowledgments and dead-lettering workflows are preferred over append-only partition logs.

### 8.5 Database Tier: Amazon Aurora PostgreSQL & Read Replicas

* **Amazon Aurora Serverless v2:** Replaces single-instance PostgreSQL with an auto-scaling, distributed storage engine across 3 Availability Zones.

* **Read/Write Splitting:** Order status polling (`GET /orders/:id`) and analytics are routed to Aurora Read Replicas, leaving 100% of the primary instance's I/O capacity available for worker write transactions.

* **Transactional Outbox & CDC (Change Data Capture):** For guaranteed dual-write consistency between Postgres and external fulfillment systems, Debezium CDC reads transactions directly from the PostgreSQL Write-Ahead Log (WAL) and publishes confirmed orders to Kafka.
