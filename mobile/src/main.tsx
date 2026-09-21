import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// The overlay loads the same bundle with ?mode=overlay and renders nothing: it
// is a voice session in a WebView the user never sees.
if (new URLSearchParams(location.search).get('mode') === 'overlay') {
  void import('./overlay-app');
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
