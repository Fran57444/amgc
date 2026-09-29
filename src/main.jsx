import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .catch(error => console.error('No se pudo activar el soporte offline de la aplicación.', error));
    });
}

createRoot(document.getElementById('root')).render(
    <App />
)
