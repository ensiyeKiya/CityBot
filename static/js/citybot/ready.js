/** Final UI polish once all modules are loaded. */
const messageInput = document.getElementById('messageInput');
const chatMessages = document.getElementById('chatMessages');

if (messageInput) messageInput.focus();
if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
