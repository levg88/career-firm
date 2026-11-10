
import express from 'express';
import server from './server';

const app = express();
const PORT = process.env.PORT || 3000;

server(app);

app.listen(PORT, () => {
  console.log(\`Server is running on port \${PORT}\`);
});
