(function () {
  var cachedApiKey = null;

  var state = {
    selectedModel: "",
    selectedNode: null,
    bomRoot: null,
    parameters: [],
    parameterTypeMap: {},
    classOptions: [],
    predictions: []
  };

  function byId(id)
  {
    return document.getElementById(id);
  }

  function setBadge(id, text, mode)
  {
    var el = byId(id);
    if (!el)
      return;

    el.textContent = text;
    el.className = "badge " + mode;
  }

  function setText(id, text)
  {
    var el = byId(id);
    if (el)
      el.textContent = text;
  }

  function setValue(id, value)
  {
    var el = byId(id);
    if (el)
      el.value = value == null ? "" : String(value);
  }

  function getValue(id)
  {
    var el = byId(id);
    return el ? String(el.value || "") : "";
  }

  function getStoredApiKey()
  {
    if (cachedApiKey !== null)
      return Promise.resolve(cachedApiKey);

    try
    {
      cachedApiKey = String(window.localStorage.getItem("creoGatewayApiKey") || "");
    }
    catch (storageError)
    {
      cachedApiKey = "";
    }

    if (cachedApiKey !== "")
      return Promise.resolve(cachedApiKey);

    return fetch("/api/local/config", { cache: "no-cache" }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (payload) {
        cachedApiKey = String(payload.apiKey || "");
        try
        {
          if (cachedApiKey !== "")
            window.localStorage.setItem("creoGatewayApiKey", cachedApiKey);
        }
        catch (persistError)
        {
        }
        return cachedApiKey;
      });
    }).catch(function () {
      cachedApiKey = "";
      return cachedApiKey;
    });
  }

  function api(path, options)
  {
    var requestOptions = options || {};
    return getStoredApiKey().then(function (apiKey) {
      var headers = requestOptions.headers || {};
      if (requestOptions.body && !headers["Content-Type"])
        headers["Content-Type"] = "application/json";
      if (apiKey !== "" && !headers.Authorization)
        headers.Authorization = "Bearer " + apiKey;

      requestOptions.headers = headers;
      return fetch(path, requestOptions).then(function (response) {
        return response.json().catch(function () {
          return {};
        }).then(function (payload) {
          if (!response.ok)
          {
            var detail = payload.detail || payload.error || response.statusText;
            throw new Error(detail);
          }

          return payload;
        });
      });
    });
  }

  function isSupportedModel(modelNameExt)
  {
    return /\.(prt|asm)$/i.test(String(modelNameExt || ""));
  }

  function setSelectedModel(modelNameExt)
  {
    state.selectedModel = String(modelNameExt || "");
    setValue("selectedModelInput", state.selectedModel);
  }

  function setCallout(id, text)
  {
    setText(id, text);
  }

  function renderClassOptions()
  {
    var list = byId("classOptions");
    if (!list)
      return;

    list.innerHTML = "";
    for (var i = 0; i < state.classOptions.length; i++)
    {
      var option = document.createElement("option");
      option.value = state.classOptions[i];
      list.appendChild(option);
    }
  }

  function flattenBom(root)
  {
    var items = [];

    function visit(node)
    {
      if (!node)
        return;

      items.push(node);
      var children = node.children || [];
      for (var i = 0; i < children.length; i++)
        visit(children[i]);
    }

    visit(root);
    return items;
  }

  function countBomNodes(root)
  {
    return flattenBom(root).length;
  }

  function getUniqueBomModels(includeRoot)
  {
    var allItems = flattenBom(state.bomRoot);
    var unique = [];
    var seen = {};

    for (var i = 0; i < allItems.length; i++)
    {
      var node = allItems[i];
      if (!includeRoot && i === 0)
        continue;

      var modelNameExt = String(node.modelNameExt || "");
      if (!isSupportedModel(modelNameExt))
        continue;

      var key = modelNameExt.toUpperCase();
      if (seen[key])
        continue;

      seen[key] = true;
      unique.push(modelNameExt);
    }

    return unique;
  }

  function syncSelectionFields(node)
  {
    state.selectedNode = node || null;
    setSelectedModel(node && node.modelNameExt ? node.modelNameExt : "");
    setValue("selectedDescriptionInput", node && node.description ? node.description : "");
    setValue("selectedFeatureIdInput", node && node.featureId ? node.featureId : "");
    setValue("selectedParentModelInput", node && node.parentAssemblyModelExt ? node.parentAssemblyModelExt : "");
    setValue("classificationInput", node && node.classification ? node.classification : "");

    var predictionText = node && node.description ? node.description : "";
    if (getValue("predictDescription").trim() === "" || predictionText !== "")
      setValue("predictDescription", predictionText);

    if (node && node.modelNameExt)
      setCallout("selectionStatus", "Selected " + node.modelNameExt + ". Open, regenerate, classify, or run Pro/PROGRAM actions from this panel.");
    else
      setCallout("selectionStatus", "No BOM item selected.");
  }

  function renderBomNode(node, depth)
  {
    var li = document.createElement("li");
    li.className = "bom-node";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "bom-item" + ((state.selectedNode && state.selectedNode.modelNameExt === node.modelNameExt && state.selectedNode.featureId === node.featureId) ? " active" : "");
    button.onclick = function () {
      syncSelectionFields(node);
      renderBomTreeSelectionOnly();
    };

    var topLine = document.createElement("span");
    topLine.className = "bom-primary";
    topLine.textContent = (node.modelNameExt || "unknown") + (depth === 0 ? " (root)" : "");

    var subLine = document.createElement("span");
    subLine.className = "bom-secondary";
    var parts = [];
    if (node.description)
      parts.push(node.description);
    if (node.classification)
      parts.push("Class: " + node.classification);
    if (node.featureId)
      parts.push("Feature: " + node.featureId);
    subLine.textContent = parts.length ? parts.join(" | ") : "No description or classification";

    button.appendChild(topLine);
    button.appendChild(subLine);
    li.appendChild(button);

    if (node.children && node.children.length)
    {
      var ul = document.createElement("ul");
      for (var i = 0; i < node.children.length; i++)
        ul.appendChild(renderBomNode(node.children[i], depth + 1));
      li.appendChild(ul);
    }

    return li;
  }

  function renderBomTree(payload)
  {
    var tree = byId("bomTree");
    tree.innerHTML = "";

    if (!payload || !payload.root)
    {
      state.bomRoot = null;
      setCallout("bomStatus", "No BOM data returned.");
      setText("bomSummary", "No BOM loaded.");
      syncSelectionFields(null);
      return;
    }

    state.bomRoot = payload.root;
    var list = document.createElement("ul");
    list.appendChild(renderBomNode(payload.root, 0));
    tree.appendChild(list);

    setText("bomSummary", String(countBomNodes(payload.root)) + " BOM items loaded.");
    setCallout("bomStatus", "BOM loaded for " + (payload.root.modelNameExt || "unknown") + ".");

    if (!state.selectedNode)
      syncSelectionFields(payload.root);
  }

  function renderBomTreeSelectionOnly()
  {
    if (!state.bomRoot)
      return;

    var tree = byId("bomTree");
    tree.innerHTML = "";
    var list = document.createElement("ul");
    list.appendChild(renderBomNode(state.bomRoot, 0));
    tree.appendChild(list);
  }

  function renderParameters(rows)
  {
    state.parameters = rows || [];
    state.parameterTypeMap = {};

    var tbody = byId("parameterRows");
    tbody.innerHTML = "";

    for (var i = 0; i < state.parameters.length; i++)
    {
      var item = state.parameters[i];
      state.parameterTypeMap[item.name] = item.typeCode;

      var tr = document.createElement("tr");

      var nameTd = document.createElement("td");
      nameTd.textContent = item.name;

      var typeTd = document.createElement("td");
      typeTd.textContent = item.typeName;

      var valueTd = document.createElement("td");
      var input = document.createElement("input");
      input.type = "text";
      input.value = item.value == null ? "" : String(item.value);
      input.className = "table-input";
      valueTd.appendChild(input);

      var actionTd = document.createElement("td");
      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "ghost";
      saveBtn.textContent = "Save";
      saveBtn.onclick = (function (name, inputRef) {
        return function () {
          saveParameter(name, inputRef.value);
        };
      })(item.name, input);
      actionTd.appendChild(saveBtn);

      tr.appendChild(nameTd);
      tr.appendChild(typeTd);
      tr.appendChild(valueTd);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
  }

  function renderPredictions(suggestions)
  {
    state.predictions = suggestions || [];
    var list = byId("predictResults");
    list.innerHTML = "";

    for (var i = 0; i < state.predictions.length; i++)
    {
      var suggestion = state.predictions[i];
      var li = document.createElement("li");
      li.className = "prediction-item";

      var text = document.createElement("span");
      var confidence = Math.round(Number(suggestion.confidence || 0) * 100);
      text.textContent = suggestion.className + " (" + confidence + "%)";

      var applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "ghost small";
      applyBtn.textContent = "Use";
      applyBtn.onclick = (function (className) {
        return function () {
          setValue("classificationInput", className);
          setCallout("predictStatus", "Loaded suggested class into BS_Class input.");
        };
      })(suggestion.className);

      li.appendChild(text);
      li.appendChild(applyBtn);
      list.appendChild(li);
    }
  }

  function refreshStatus()
  {
    Promise.all([api("/health"), api("/api/bridge/status")])
      .then(function (results) {
        var health = results[0];
        var bridge = results[1];

        if (health.modelLoaded && health.modelRuntimeReady)
        {
          setBadge("mlStatusBadge", "Ready", "ok");
          setText("mlStatusText", "Classifier loaded from " + health.modelPath);
        }
        else if (health.modelLoaded)
        {
          setBadge("mlStatusBadge", "Deps Missing", "warn");
          setText("mlStatusText", "Model artifact exists, but this Python environment cannot load it.");
        }
        else
        {
          setBadge("mlStatusBadge", "No Model", "warn");
          setText("mlStatusText", "Train the local classifier to enable suggestions.");
        }

        if (bridge.connected)
        {
          setBadge("bridgeStatusBadge", "Connected", "ok");
          setText("bridgeStatusText", (bridge.client || "Creo Embedded Browser") + " connected.");
          setCallout("connectionLog", "Bridge ready. External actions can reach Creo.");
        }
        else
        {
          setBadge("bridgeStatusBadge", "Disconnected", "warn");
          setText("bridgeStatusText", "Load /creo_bridge.html inside Creo to enable commands.");
          setCallout("connectionLog", "Bridge disconnected. The page stays available, but Creo operations will fail until the bridge reconnects.");
        }
      })
      .catch(function (error) {
        setBadge("bridgeStatusBadge", "Error", "warn");
        setBadge("mlStatusBadge", "Error", "warn");
        setCallout("connectionLog", error.message);
      });
  }

  function loadCatalogClasses()
  {
    api("/api/classes")
      .then(function (payload) {
        state.classOptions = payload.classes || [];
        renderClassOptions();
      })
      .catch(function () {
        state.classOptions = [];
        renderClassOptions();
      });
  }

  function loadCurrentModel()
  {
    api("/api/model/current")
      .then(function (payload) {
        var modelNameExt = payload.modelNameExt || "";
        setValue("currentModelInput", modelNameExt);
        setText("heroModelName", modelNameExt || "Unknown");
        if (!state.selectedNode)
          setSelectedModel(modelNameExt);
        setCallout("connectionLog", "Current Creo model: " + (modelNameExt || "unknown") + ".");
      })
      .catch(function (error) {
        setCallout("connectionLog", error.message);
      });
  }

  function loadCurrentDirectory()
  {
    api("/api/directory/current")
      .then(function (payload) {
        var directory = payload.directoryPath || "";
        setValue("currentDirectoryInput", directory);
        setText("heroDirectoryText", directory || "Current directory unknown.");
      })
      .catch(function (error) {
        setCallout("connectionLog", error.message);
      });
  }

  function setCurrentDirectory()
  {
    var directoryPath = getValue("currentDirectoryInput").trim();
    if (directoryPath === "")
    {
      setCallout("connectionLog", "Enter a directory path first.");
      return;
    }

    setCallout("connectionLog", "Setting Creo directory...");
    api("/api/directory/current", {
      method: "POST",
      body: JSON.stringify({ directoryPath: directoryPath })
    })
      .then(function () {
        setText("heroDirectoryText", directoryPath);
        setCallout("connectionLog", "Creo working directory set to " + directoryPath + ".");
      })
      .catch(function (error) {
        setCallout("connectionLog", error.message);
      });
  }

  function loadBom()
  {
    setCallout("bomStatus", "Loading BOM from Creo...");
    api("/api/bom")
      .then(function (payload) {
        state.selectedNode = null;
        renderBomTree(payload);
      })
      .catch(function (error) {
        setCallout("bomStatus", error.message);
      });
  }

  function ensureSelectedModel()
  {
    var modelNameExt = getValue("selectedModelInput").trim();
    if (modelNameExt !== "")
      setSelectedModel(modelNameExt);

    if (state.selectedModel === "")
      throw new Error("Select a model first.");

    return state.selectedModel;
  }

  function loadParameters()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("parameterStatus", error.message);
      return;
    }

    setCallout("parameterStatus", "Loading parameters for " + modelNameExt + "...");
    api("/api/parameters/" + encodeURIComponent(modelNameExt))
      .then(function (payload) {
        renderParameters(payload.parameters || []);
        setCallout("parameterStatus", "Loaded " + String((payload.parameters || []).length) + " parameters for " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("parameterStatus", error.message);
      });
  }

  function saveParameter(paramName, rawValue)
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("parameterStatus", error.message);
      return;
    }

    setCallout("parameterStatus", "Saving " + paramName + "...");
    api("/api/parameters/set", {
      method: "POST",
      body: JSON.stringify({
        modelNameExt: modelNameExt,
        paramName: paramName,
        paramType: state.parameterTypeMap[paramName],
        rawValue: rawValue
      })
    })
      .then(function () {
        if (paramName.toUpperCase() === "BS_CLASS")
          setValue("classificationInput", rawValue);
        setCallout("parameterStatus", "Saved " + paramName + " for " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("parameterStatus", error.message);
      });
  }

  function createParameter()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("parameterStatus", error.message);
      return;
    }

    var paramName = getValue("newParamName").trim();
    var paramType = getValue("newParamType");
    var rawValue = getValue("newParamValue");

    if (paramName === "")
    {
      setCallout("parameterStatus", "Parameter name is required.");
      return;
    }

    setCallout("parameterStatus", "Creating " + paramName + "...");
    api("/api/parameters/create", {
      method: "POST",
      body: JSON.stringify({
        modelNameExt: modelNameExt,
        paramName: paramName,
        paramType: paramType,
        rawValue: rawValue
      })
    })
      .then(function () {
        setCallout("parameterStatus", "Created " + paramName + " for " + modelNameExt + ".");
        loadParameters();
      })
      .catch(function (error) {
        setCallout("parameterStatus", error.message);
      });
  }

  function saveClassification()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("predictStatus", error.message);
      return;
    }

    var value = getValue("classificationInput").trim();
    setCallout("predictStatus", "Saving BS_Class...");
    api("/api/classification/save", {
      method: "POST",
      body: JSON.stringify({
        modelNameExt: modelNameExt,
        value: value
      })
    })
      .then(function () {
        if (state.selectedNode)
          state.selectedNode.classification = value;
        renderBomTreeSelectionOnly();
        setCallout("predictStatus", "Saved BS_Class for " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("predictStatus", error.message);
      });
  }

  function predictClassification()
  {
    var description = getValue("predictDescription").trim();
    if (description === "")
    {
      setCallout("predictStatus", "Enter a description first.");
      return;
    }

    setCallout("predictStatus", "Running local prediction...");
    api("/predict", {
      method: "POST",
      body: JSON.stringify({
        description: description,
        topK: 5,
        useSynonymAssist: true,
        synonymThreshold: 0.8,
        synonymWeight: 0.35
      })
    })
      .then(function (payload) {
        renderPredictions(payload.suggestions || []);
        setCallout("predictStatus", "Prediction complete using " + (payload.provider || "unknown") + ".");
      })
      .catch(function (error) {
        renderPredictions([]);
        setCallout("predictStatus", error.message);
      });
  }

  function applyTopPrediction()
  {
    if (!state.predictions.length)
    {
      setCallout("predictStatus", "Run prediction first.");
      return;
    }

    setValue("classificationInput", state.predictions[0].className || "");
    setCallout("predictStatus", "Top prediction copied into BS_Class.");
  }

  function openSelectedModel()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("selectionStatus", error.message);
      return;
    }

    setCallout("selectionStatus", "Opening " + modelNameExt + "...");
    api("/api/model/open", {
      method: "POST",
      body: JSON.stringify({ modelNameExt: modelNameExt })
    })
      .then(function () {
        setCallout("selectionStatus", "Opened " + modelNameExt + " in Creo.");
      })
      .catch(function (error) {
        setCallout("selectionStatus", error.message);
      });
  }

  function regenerateSelectedModel()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("selectionStatus", error.message);
      return;
    }

    setCallout("selectionStatus", "Regenerating " + modelNameExt + "...");
    api("/api/model/regenerate", {
      method: "POST",
      body: JSON.stringify({ modelNameExt: modelNameExt })
    })
      .then(function () {
        setCallout("selectionStatus", "Regenerated " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("selectionStatus", error.message);
      });
  }

  function runMacro()
  {
    var macro = getValue("macroInput").trim();
    var workingDirectory = getValue("macroWorkingDirectory").trim();
    if (macro === "")
    {
      setCallout("macroStatus", "Enter a macro string first.");
      return;
    }

    setCallout("macroStatus", "Running macro in Creo...");
    api("/api/macro", {
      method: "POST",
      body: JSON.stringify({
        macro: macro,
        workingDirectory: workingDirectory
      })
    })
      .then(function () {
        setCallout("macroStatus", "Macro executed successfully.");
      })
      .catch(function (error) {
        setCallout("macroStatus", error.message);
      });
  }

  function runBomMacro()
  {
    if (!state.bomRoot)
    {
      setCallout("macroStatus", "Load the BOM first.");
      return;
    }

    var macro = getValue("macroInput").trim();
    var workingDirectory = getValue("macroWorkingDirectory").trim();
    var includeRoot = !!byId("macroIncludeRootInput").checked;
    var delayMs = parseInt(getValue("macroDelayInput"), 10);
    if (isNaN(delayMs) || delayMs < 0)
      delayMs = 1500;

    var models = getUniqueBomModels(includeRoot);
    if (macro === "")
    {
      setCallout("macroStatus", "Enter a macro string first.");
      return;
    }
    if (!models.length)
    {
      setCallout("macroStatus", "No supported models found in the BOM.");
      return;
    }

    setCallout("macroStatus", "Running macro across " + String(models.length) + " models...");
    api("/api/macro/bom", {
      method: "POST",
      body: JSON.stringify({
        macro: macro,
        workingDirectory: workingDirectory,
        delayMs: delayMs,
        models: models,
        parentModelNameExt: state.bomRoot.modelNameExt || ""
      })
    })
      .then(function (payload) {
        setCallout("macroStatus", payload.message || "BOM macro complete.");
      })
      .catch(function (error) {
        setCallout("macroStatus", error.message);
      });
  }

  function programExport()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("programStatus", error.message);
      return;
    }

    var filePath = getValue("programFilePathInput").trim();
    if (filePath === "")
    {
      setCallout("programStatus", "Enter a target TXT file path first.");
      return;
    }

    setCallout("programStatus", "Exporting Pro/PROGRAM for " + modelNameExt + "...");
    api("/api/program/export", {
      method: "POST",
      body: JSON.stringify({
        modelNameExt: modelNameExt,
        filePath: filePath
      })
    })
      .then(function () {
        setCallout("programStatus", "Exported Pro/PROGRAM for " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("programStatus", error.message);
      });
  }

  function programImport()
  {
    var modelNameExt;
    try
    {
      modelNameExt = ensureSelectedModel();
    }
    catch (error)
    {
      setCallout("programStatus", error.message);
      return;
    }

    var filePath = getValue("programFilePathInput").trim();
    if (filePath === "")
    {
      setCallout("programStatus", "Enter a source TXT file path first.");
      return;
    }

    setCallout("programStatus", "Importing Pro/PROGRAM for " + modelNameExt + "...");
    api("/api/program/import", {
      method: "POST",
      body: JSON.stringify({
        modelNameExt: modelNameExt,
        filePath: filePath
      })
    })
      .then(function () {
        setCallout("programStatus", "Imported Pro/PROGRAM for " + modelNameExt + ".");
      })
      .catch(function (error) {
        setCallout("programStatus", error.message);
      });
  }

  function programBatchExport()
  {
    if (!state.bomRoot)
    {
      setCallout("programStatus", "Load the BOM first.");
      return;
    }

    var directoryPath = getValue("programBatchDirectoryInput").trim();
    var models = getUniqueBomModels(true);
    if (directoryPath === "")
    {
      setCallout("programStatus", "Enter a batch folder first.");
      return;
    }
    if (!models.length)
    {
      setCallout("programStatus", "No supported BOM models found to export.");
      return;
    }

    setCallout("programStatus", "Batch exporting " + String(models.length) + " models...");
    api("/api/program/batch/export", {
      method: "POST",
      body: JSON.stringify({
        directoryPath: directoryPath,
        models: models,
        parentModelNameExt: state.bomRoot.modelNameExt || ""
      })
    })
      .then(function (payload) {
        setCallout("programStatus", payload.message || "Batch export complete.");
      })
      .catch(function (error) {
        setCallout("programStatus", error.message);
      });
  }

  function programBatchImport()
  {
    if (!state.bomRoot)
    {
      setCallout("programStatus", "Load the BOM first.");
      return;
    }

    var directoryPath = getValue("programBatchDirectoryInput").trim();
    var models = getUniqueBomModels(true);
    if (directoryPath === "")
    {
      setCallout("programStatus", "Enter a batch folder first.");
      return;
    }
    if (!models.length)
    {
      setCallout("programStatus", "No supported BOM models found to import.");
      return;
    }

    setCallout("programStatus", "Batch importing " + String(models.length) + " models...");
    api("/api/program/batch/import", {
      method: "POST",
      body: JSON.stringify({
        directoryPath: directoryPath,
        models: models,
        parentModelNameExt: state.bomRoot.modelNameExt || ""
      })
    })
      .then(function (payload) {
        setCallout("programStatus", payload.message || "Batch import complete.");
      })
      .catch(function (error) {
        setCallout("programStatus", error.message);
      });
  }

  function programClean()
  {
    var directoryPath = getValue("programBatchDirectoryInput").trim();
    if (directoryPath === "")
    {
      setCallout("programStatus", "Enter a batch folder first.");
      return;
    }

    setCallout("programStatus", "Cleaning Pro/PROGRAM TXT files...");
    api("/api/program/clean", {
      method: "POST",
      body: JSON.stringify({ directoryPath: directoryPath })
    })
      .then(function (payload) {
        setCallout("programStatus", payload.message || "TXT cleanup complete.");
      })
      .catch(function (error) {
        setCallout("programStatus", error.message);
      });
  }

  function bomToCsvRows()
  {
    var rows = [["Level", "Model", "Description", "Classification", "FeatureId", "ParentAssembly"]];
    var items = flattenBom(state.bomRoot);

    for (var i = 0; i < items.length; i++)
    {
      var node = items[i];
      rows.push([
        node.number || "",
        node.modelNameExt || "",
        node.description || "",
        node.classification || "",
        node.featureId || "",
        node.parentAssemblyModelExt || ""
      ]);
    }

    return rows;
  }

  function csvEscape(value)
  {
    var text = String(value == null ? "" : value);
    if (/[",\n]/.test(text))
      return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function exportBomCsv()
  {
    if (!state.bomRoot)
    {
      setCallout("selectionStatus", "Load the BOM first.");
      return;
    }

    var csv = bomToCsvRows().map(function (row) {
      return row.map(csvEscape).join(",");
    }).join("\r\n");

    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var link = document.createElement("a");
    var fileName = (state.bomRoot.modelNameExt || "bom").replace(/\.[^\.]+$/, "") + "_bom.csv";
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setCallout("selectionStatus", "Exported BOM CSV to browser download: " + fileName + ".");
  }

  function bind()
  {
    byId("refreshStatusBtn").onclick = refreshStatus;
    byId("loadCurrentModelBtn").onclick = function () {
      loadCurrentModel();
      loadCurrentDirectory();
    };
    byId("loadDirectoryBtn").onclick = loadCurrentDirectory;
    byId("setDirectoryBtn").onclick = setCurrentDirectory;
    byId("loadBomBtn").onclick = loadBom;
    byId("openModelBtn").onclick = openSelectedModel;
    byId("regenerateModelBtn").onclick = regenerateSelectedModel;
    byId("loadParametersBtn").onclick = loadParameters;
    byId("createParameterBtn").onclick = createParameter;
    byId("saveClassificationBtn").onclick = saveClassification;
    byId("predictBtn").onclick = predictClassification;
    byId("applyTopPredictionBtn").onclick = applyTopPrediction;
    byId("runMacroBtn").onclick = runMacro;
    byId("runBomMacroBtn").onclick = runBomMacro;
    byId("programExportBtn").onclick = programExport;
    byId("programImportBtn").onclick = programImport;
    byId("programBatchExportBtn").onclick = programBatchExport;
    byId("programBatchImportBtn").onclick = programBatchImport;
    byId("programCleanBtn").onclick = programClean;
    byId("exportBomCsvBtn").onclick = exportBomCsv;
    byId("selectedModelInput").addEventListener("change", function () {
      setSelectedModel(getValue("selectedModelInput").trim());
    });
  }

  bind();
  loadCatalogClasses();
  refreshStatus();
  loadCurrentModel();
  loadCurrentDirectory();
  window.setInterval(refreshStatus, 5000);
})();