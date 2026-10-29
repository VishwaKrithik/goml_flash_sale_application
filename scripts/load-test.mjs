import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

export const ordersAccepted = new Counter('orders_accepted_202');
export const ordersRejected = new Counter('orders_rejected_409');
export const errorsOther = new Counter('errors_other');

export const options = {
  scenarios: {
    flash_crowd: {
      executor: 'shared-iterations',
      vus: 100, // 100 parallel concurrent connections
      iterations: 10000, // 10,000 total checkout attempts
      maxDuration: '60s',
    },
  },
};

export default function () {
  const target = __ENV.TARGET_URL || 'http://localhost:8080/checkout';
  const uniqueId = `load-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': uniqueId,
      'idempotency-key': `idem-${uniqueId}`,
    },
    timeout: '5s',
  };

  const res = http.post(target, JSON.stringify({}), params);

  if (res.status === 202) {
    ordersAccepted.add(1);
  } else if (res.status === 409) {
    ordersRejected.add(1);
  } else {
    errorsOther.add(1);
  }

  check(res, {
    'status is 202 or 409': (r) => r.status === 202 || r.status === 409,
  });
}