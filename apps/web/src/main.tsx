import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AccountGate } from './AccountGate.tsx';
import { FloatingGuide } from './FloatingGuide.tsx';
import { installRipple } from './ripple.ts';
import './styles.css';
import './polish.css';
import './brand.css';

// Keep the customer on one approved sign-in host; no account data is moved.
if (window.location.hostname === 'promo-iaulin-mkce.vercel.app') {
  window.location.replace('https://iaulinbot.vercel.app'+window.location.pathname+window.location.search+window.location.hash);
} else {
  installRipple();
  createRoot(document.getElementById('root')!).render(<React.StrictMode><AccountGate><App /><FloatingGuide /></AccountGate></React.StrictMode>);
}

