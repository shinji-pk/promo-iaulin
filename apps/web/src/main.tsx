import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AccountGate } from './AccountGate.tsx';
import { FloatingGuide } from './FloatingGuide.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AccountGate><App /><FloatingGuide /></AccountGate></React.StrictMode>);
