import { render } from 'solid-js/web';
import { App } from './App';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from manager.html');

render(() => <App />, root);
