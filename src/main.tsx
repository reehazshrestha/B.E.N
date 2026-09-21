import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { DynamicNotch } from './components/DynamicNotch';
import './index.css';

const isNotchMode = window.location.search.includes('mode=notch');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isNotchMode ? <DynamicNotch /> : <App />}
  </React.StrictMode>
);
