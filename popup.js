document.getElementById('zipButton').addEventListener('click', () => {
  console.log("Popup button clicked. Sending message to background script.");
  browser.runtime.sendMessage({ action: "createZip" })
    .then(response => {
      console.log("Response from background script:", response);
      // Optionally update popup UI based on response (e.g., show success/error)
      if (response && response.status === "success") {
        window.close(); // Close popup on success
      } else {
        // Handle error display if needed
        console.error("Zip creation failed or no response.");
      }
    })
    .catch(error => {
      console.error("Error sending message:", error);
      // Handle error display if needed
    });
});
