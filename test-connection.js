
const axios = require('axios');

async function testBackend() {
  const url = 'https://scraper-backend-ys3q.onrender.com/api/scrape';
  console.log(`Testing connection to: ${url}`);
  
  try {
    // We expect this to fail with 401 (if secured) or 400 (if open but missing body)
    // If it fails with ECONNREFUSED or 404, that's a problem.
    const response = await axios.post(url, {});
    console.log('Response Status:', response.status);
    console.log('Response Data:', response.data);
  } catch (error) {
    if (error.response) {
      console.log('✅ Server Responded!');
      console.log('Status:', error.response.status);
      console.log('Status Text:', error.response.statusText);
      console.log('Data:', error.response.data);
      
      if (error.response.status === 401) {
        console.log('\n--- DIAGNOSIS ---');
        console.log('The backend is SECURE and working.');
        console.log('You must enter the API Access Code in the frontend settings.');
      } else if (error.response.status === 400) {
        console.log('\n--- DIAGNOSIS ---');
        console.log('The backend is OPEN and working (no secret required).');
      }
    } else {
      console.log('❌ Connection Failed:', error.message);
      console.log('\n--- DIAGNOSIS ---');
      console.log('The backend is NOT reachable. Check Render status.');
    }
  }
}

testBackend();
