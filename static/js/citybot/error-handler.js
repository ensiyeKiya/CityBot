window.addEventListener('error', function (event) {
  console.error('Global error caught:', {
    message: event.message,
    source: event.filename,
    lineNo: event.lineno,
    colNo: event.colno,
    error: event.error,
  });

  if (event.filename && event.filename.includes('mqtt')) {
    console.error('MQTT library error details:', {
      stack: event.error?.stack,
      name: event.error?.name,
      additionalInfo: event.error?.toString(),
    });
  }
});
