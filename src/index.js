export default {
  async fetch(request, env) {
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>RandomTalk</title>
</head>
<body>
  <h1>RandomTalk</h1>
  <p>Worker is working!</p>
</body>
</html>`,
      {
        headers: {
          "content-type": "text/html; charset=UTF-8"
        }
      }
    );
  }
};
