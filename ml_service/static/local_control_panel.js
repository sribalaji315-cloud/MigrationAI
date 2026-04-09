(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var el = byId(id);
    if (el)
      el.textContent = value == null ? "" : String(value);
  }

  function setValue(id, value) {
    var el = byId(id);
    if (el)
      el.value = value == null ? "" : String(value);
  }

  function setStatus(el, ok, warnText, okText) {
    if (!el)
      return;
    el.className = "status " + (ok ? "ok" : "warn");
    el.textContent = ok ? okText : warnText;
  }

  function copyText(value, label) {
    if (!value)
      return Promise.resolve();
    return navigator.clipboard.writeText(String(value)).then(function () {
      setText("saveMessage", label + " copied to clipboard.");
    }).catch(function () {
      setText("saveMessage", "Unable to copy automatically. Select and copy manually.");
    });
  }

  function readConfig() {
    return fetch("/api/local/config", { cache: "no-cache" }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok)
          throw new Error(payload.detail || response.statusText || "Failed to load local config.");
        return payload;
      });
    });
  }

  function saveConfig(payload) {
    return fetch("/api/local/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok)
          throw new Error(data.detail || response.statusText || "Failed to save local config.");
        return data;
      });
    });
  }

  function applyConfig(config) {
    try {
      window.localStorage.setItem("creoGatewayBaseUrl", config.currentBaseUrl || "");
      window.localStorage.setItem("creoGatewayApiKey", config.apiKey || "");
    } catch (storageError) {
    }

    setValue("gatewayUrlInput", config.currentBaseUrl || "");
    setValue("apiKeyInput", config.apiKey || "");
    setValue("allowedOriginInput", config.allowedOrigin || "");
    setValue("localPortInput", config.configuredPort || config.currentPort || "8000");
    setText("bridgeClientValue", config.bridgeClient || "Waiting for embedded browser");
    setText("statusMessage", config.restartRequired ? "Configuration saved. Restart the local service to apply port/CORS changes." : "Local gateway settings loaded.");
    setText("gatewayUrlBadge", "Port " + String(config.currentPort || config.configuredPort || "8000"));
    setStatus(byId("bridgeStatusValue"), !!config.bridgeConnected, "Offline", "Connected");
    setStatus(byId("modelStatusValue"), !!config.modelRuntimeReady, "Not ready", "Ready");
    byId("restartBadge").className = config.restartRequired ? "badge warn" : "badge hidden";
    byId("openBridgeLink").href = config.bridgeUrl || "/creo_bridge.html";
    byId("openWorkbenchLink").href = config.workbenchUrl || "/index.html";
  }

  function refresh() {
    return readConfig().then(applyConfig).catch(function (error) {
      setText("statusMessage", error.message || error);
    });
  }

  byId("refreshStatusBtn").addEventListener("click", refresh);
  byId("copyGatewayUrlBtn").addEventListener("click", function () {
    copyText(byId("gatewayUrlInput").value, "Gateway URL");
  });
  byId("copyApiKeyBtn").addEventListener("click", function () {
    copyText(byId("apiKeyInput").value, "API key");
  });
  byId("saveConfigBtn").addEventListener("click", function () {
    var portValue = parseInt(byId("localPortInput").value, 10);
    saveConfig({
      allowedOrigin: byId("allowedOriginInput").value,
      localPort: isNaN(portValue) ? 8000 : portValue
    }).then(applyConfig).catch(function (error) {
      setText("saveMessage", error.message || error);
    });
  });

  refresh();
})();
