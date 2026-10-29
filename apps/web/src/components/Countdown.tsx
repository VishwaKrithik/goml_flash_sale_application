import React, { useState, useEffect } from 'react';

interface CountdownProps {
  onSaleLive: () => void;
}

export const Countdown: React.FC<CountdownProps> = ({ onSaleLive }) => {
  const [secondsLeft, setSecondsLeft] = useState<number>(5);

  useEffect(() => {
    if (secondsLeft <= 0) {
      // Defer state update to next microtask tick so it doesn't collide with render
      queueMicrotask(() => onSaleLive());
      return;
    }

    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          queueMicrotask(() => onSaleLive());
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsLeft, onSaleLive]);

  if (secondsLeft <= 0) {
    return <span style={{ color: '#22c55e', fontWeight: 600 }}>SALE IS LIVE NOW!</span>;
  }

  return (
    <div style={{ fontSize: '1.1rem', color: '#f59e0b', fontWeight: 500 }}>
      Sale begins in: <strong>00:0{secondsLeft}s</strong>
    </div>
  );
};