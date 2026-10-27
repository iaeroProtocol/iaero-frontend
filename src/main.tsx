import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {AppErrorBoundary} from './async-section';
import './styles.css';
import './readability.css';
import './visual-upgrade.css';
import './overview-dashboard.css';
import './portfolio-dashboard.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><App/></AppErrorBoundary></React.StrictMode>);
