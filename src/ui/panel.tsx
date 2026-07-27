import { render } from 'solid-js/web';
import { App } from './App';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from panel.html');

// Same app, single-column composition — the panel is ~400px wide, so the sidebar
// and detail pane are dropped rather than squeezed.
render(() => <App compact />, root);
