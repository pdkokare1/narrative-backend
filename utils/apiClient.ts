// utils/apiClient.ts
import axios from 'axios';
import logger from './logger';

const apiClient = axios.create({
    timeout: 30000, // 30 seconds global timeout
    headers: {
        'User-Agent': 'NarrativeNews-Backend/1.0',
        'Accept': 'application/json'
    }
});

// Optional: Add logging for slow requests
apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.code === 'ECONNABORTED') {
            logger.warn(`⚠️ Request timed out: ${error.config?.url}`);
        }
        return Promise.reject(error);
    }
);

export default apiClient;
