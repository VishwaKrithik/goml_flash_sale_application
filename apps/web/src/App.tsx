import React, { useState } from 'react';
import { Countdown } from './components/Countdown';

type OrderState =
  | 'IDLE'
  | 'WAITING_SALE'
  | 'SUBMITTING'
  | 'PROCESSING'
  | 'CONFIRMED'
  | 'SOLD_OUT'
  | 'ALREADY_PURCHASED'
  | 'ERROR_RETRYING';

// Helper function to guarantee synchronous initial ID
function getInitialUserId(): string {
  if (typeof window === 'undefined') return '';
  const existing = localStorage.getItem('flash_user_id');
  if (existing) return existing;
  const generated = `user_${Math.random().toString(36).substring(2, 9)}`;
  localStorage.setItem('flash_user_id', generated);
  return generated;
}

export const App: React.FC = () => {
  // Initialize state synchronously so userId is NEVER empty
  const [userId, setUserId] = useState<string>(getInitialUserId);
  const [state, setState] = useState<OrderState>('WAITING_SALE');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [pollAttempt, setPollAttempt] = useState<number>(0);

  const handleSaleLive = () => {
    setState((prev) => (prev === 'WAITING_SALE' ? 'IDLE' : prev));
  };

  const handleBuy = async () => {
    // Fallback safeguard: Ensure userId exists
    const currentUserId = userId || getInitialUserId();
    if (!userId) setUserId(currentUserId);

    // 1. Instant lock
    setState('SUBMITTING');
    setStatusMessage('Reserving stock in Redis memory...');

    const idemKey = `idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': currentUserId,
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({}), // Explicit empty body prevents parser 400s
      });

      if (res.status === 202) {
        const data = await res.json();
        setOrderId(data.orderId);
        setState('PROCESSING');
        setStatusMessage('Stock reserved! Finalizing database transaction...');
        pollOrderStatus(data.orderId, 1);
      } else if (res.status === 409) {
        const data = await res.json();
        if (data.error === 'SOLD_OUT') {
          setState('SOLD_OUT');
          setStatusMessage('Sold Out: All 500 units have been claimed.');
        } else if (data.error === 'ALREADY_PURCHASED') {
          setState('ALREADY_PURCHASED');
          setStatusMessage('You have already purchased this item.');
        } else {
          setState('ERROR_RETRYING');
          setStatusMessage(`Conflict error: ${data.error}`);
        }
      } else if (res.status === 429) {
        setState('ERROR_RETRYING');
        setStatusMessage('High traffic: Rate limit reached. Please wait a moment.');
      } else {
        const errorData = await res.json().catch(() => ({}));
        setState('ERROR_RETRYING');
        setStatusMessage(`Error ${res.status}: ${JSON.stringify(errorData)}`);
      }
    } catch (err: any) {
      setState('ERROR_RETRYING');
      setStatusMessage(`Network error: ${err.message}`);
    }
  };

  const pollOrderStatus = async (targetOrderId: string, attempt: number) => {
    setPollAttempt(attempt);

    try {
      const res = await fetch(`/api/orders/${targetOrderId}`);
      if (res.status === 200) {
        const data = await res.json();
        if (data.status === 'CONFIRMED') {
          setState('CONFIRMED');
          setStatusMessage('Payment & Inventory Confirmed! Order complete.');
          return;
        } else if (data.status === 'FAILED') {
          setState('SOLD_OUT');
          setStatusMessage('Order failed during final allocation.');
          return;
        }
      }
    } catch {
      // Ignore polling connection blips
    }

    const baseDelay = Math.min(1000 * Math.pow(1.5, attempt), 5000);
    const jitter = Math.floor(Math.random() * 300);
    const delay = baseDelay + jitter;

    setTimeout(() => {
      pollOrderStatus(targetOrderId, attempt + 1);
    }, delay);
  };

  const resetUserSession = () => {
    const nextId = `user_${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem('flash_user_id', nextId);
    setUserId(nextId);
    setState('IDLE');
    setOrderId(null);
    setStatusMessage('');
    setPollAttempt(0);
  };

  return (
    <div style={{ maxWidth: '480px', margin: '40px auto', padding: '24px', backgroundColor: '#1e293b', borderRadius: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
      <h2 style={{ margin: '0 0 8px 0', fontSize: '1.5rem', color: '#38bdf8' }}>Flash Sale: Galaxy Apex 5G</h2>
      <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '16px' }}>Only 500 units available. First come, first served.</p>

      <div style={{ backgroundColor: '#0f172a', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>
        <Countdown onSaleLive={handleSaleLive} />
      </div>

      <div style={{ marginBottom: '20px', fontSize: '0.85rem', color: '#cbd5e1' }}>
        <div><strong>User ID:</strong> <code style={{ color: '#a78bfa' }}>{userId}</code></div>
        {orderId && <div><strong>Order ID:</strong> <code style={{ color: '#34d399' }}>{orderId}</code></div>}
      </div>

      <button
        onClick={handleBuy}
        disabled={state !== 'IDLE'}
        style={{
          width: '100%',
          padding: '14px',
          fontSize: '1.1rem',
          fontWeight: 700,
          borderRadius: '8px',
          border: 'none',
          cursor: state === 'IDLE' ? 'pointer' : 'not-allowed',
          backgroundColor: state === 'IDLE' ? '#2563eb' : '#475569',
          color: '#ffffff',
          transition: 'background-color 0.15s ease',
        }}
      >
        {state === 'WAITING_SALE' && 'Sale Locked'}
        {state === 'IDLE' && 'Buy Now ($799)'}
        {state === 'SUBMITTING' && 'Securing Unit...'}
        {state === 'PROCESSING' && `Confirming (Poll #${pollAttempt})...`}
        {state === 'CONFIRMED' && 'Order Confirmed!'}
        {state === 'SOLD_OUT' && 'Sold Out'}
        {state === 'ALREADY_PURCHASED' && 'Already Claimed'}
        {state === 'ERROR_RETRYING' && 'Failed - Check Status'}
      </button>

      {statusMessage && (
        <div style={{ marginTop: '16px', padding: '12px', borderRadius: '6px', fontSize: '0.9rem', backgroundColor: state === 'CONFIRMED' ? '#064e3b' : state === 'SOLD_OUT' ? '#7f1d1d' : '#1e1b4b', color: state === 'CONFIRMED' ? '#6ee7b7' : state === 'SOLD_OUT' ? '#fca5a5' : '#c7d2fe' }}>
          {statusMessage}
        </div>
      )}

      <button
        onClick={resetUserSession}
        style={{ marginTop: '24px', background: 'transparent', border: '1px solid #475569', color: '#94a3b8', borderRadius: '6px', padding: '8px 12px', fontSize: '0.8rem', cursor: 'pointer' }}
      >
        Simulate Different User (New User ID)
      </button>
    </div>
  );
};