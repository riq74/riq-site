(function () {
  const STORAGE_KEY = "geradorPixState";
  const MAX_LOGO_BYTES = 1_500_000;
  const CITY = "BRASIL";
  const CURRENCY = "986";
  const PIX_KEY_TYPES = ["random", "phone", "email", "cpf", "cnpj"];

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function readState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeState(state) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clearState() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function stripAccents(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function normalizeText(value, { allowSpaces, maxLength }) {
    const withoutAccents = stripAccents(value).toUpperCase();
    const pattern = allowSpaces ? /[^A-Z0-9 ]+/g : /[^A-Z0-9]+/g;
    const cleaned = withoutAccents.replace(pattern, allowSpaces ? " " : "");
    const compact = allowSpaces ? cleaned.replace(/\s+/g, " ").trim() : cleaned;
    return compact.slice(0, maxLength);
  }

  function sanitizeMerchantName(value) {
    return normalizeText(value, { allowSpaces: true, maxLength: 25 });
  }

  function sanitizeTxid(value) {
    return normalizeText(value, { allowSpaces: false, maxLength: 25 });
  }

  function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function isAllSameDigits(value) {
    return /^\d+$/.test(value) && /^([0-9])\1+$/.test(value);
  }

  function validateCpfDigits(cpf) {
    if (!/^\d{11}$/.test(cpf) || isAllSameDigits(cpf)) {
      return false;
    }

    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
      sum += Number(cpf[i]) * (10 - i);
    }
    let firstDigit = (sum * 10) % 11;
    if (firstDigit === 10) firstDigit = 0;
    if (firstDigit !== Number(cpf[9])) return false;

    sum = 0;
    for (let i = 0; i < 10; i += 1) {
      sum += Number(cpf[i]) * (11 - i);
    }
    let secondDigit = (sum * 10) % 11;
    if (secondDigit === 10) secondDigit = 0;
    return secondDigit === Number(cpf[10]);
  }

  function validateCnpjDigits(cnpj) {
    if (!/^\d{14}$/.test(cnpj) || isAllSameDigits(cnpj)) {
      return false;
    }

    const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(cnpj[i]) * weights1[i];
    }
    let firstDigit = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (firstDigit !== Number(cnpj[12])) return false;

    sum = 0;
    for (let i = 0; i < 13; i += 1) {
      sum += Number(cnpj[i]) * weights2[i];
    }
    let secondDigit = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    return secondDigit === Number(cnpj[13]);
  }

  function normalizePixKey(type, value) {
    const raw = String(value || "");
    switch (type) {
      case "phone": {
        let digits = onlyDigits(raw);
        if (!digits) return "";
        if (digits.startsWith("55") && digits.length > 11) {
          digits = digits.slice(2);
        }
        return `+55${digits}`;
      }
      case "cpf":
        return onlyDigits(raw).slice(0, 11);
      case "cnpj":
        return onlyDigits(raw).slice(0, 14);
      case "email":
        return raw.trim().toLowerCase();
      case "random":
        return raw.trim();
      default:
        return raw.trim();
    }
  }

  function getPixKeyDisplayValue(type, value) {
    const raw = String(value || "");
    switch (type) {
      case "phone": {
        let digits = onlyDigits(raw);
        if (digits.startsWith("55") && digits.length > 11) {
          digits = digits.slice(2);
        }
        return digits.slice(0, 11);
      }
      case "cpf":
        return onlyDigits(raw).slice(0, 11);
      case "cnpj":
        return onlyDigits(raw).slice(0, 14);
      case "email":
        return raw.trim().toLowerCase();
      case "random":
        return raw.trim();
      default:
        return raw.trim();
    }
  }

  function validatePixKey(type, normalizedValue) {
    const value = String(normalizedValue || "");

    if (!type) {
      return "Selecione o tipo da chave Pix.";
    }

    switch (type) {
      case "phone":
        if (!/^\+55\d{11}$/.test(value)) {
          return "Telefone inválido. Informe DDD + número de celular. Exemplo: (11) 98888-7777.";
        }
        return null;
      case "cpf":
        if (!validateCpfDigits(value)) {
          return "CPF inválido. Confira os 11 dígitos.";
        }
        return null;
      case "cnpj":
        if (!validateCnpjDigits(value)) {
          return "CNPJ inválido. Confira os 14 dígitos.";
        }
        return null;
      case "email":
        if (value.length > 77 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return "E-mail inválido. Informe um e-mail válido, como nome@email.com.";
        }
        return null;
      case "random":
        if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
          return "Chave aleatória inválida. Informe a chave completa no formato UUID.";
        }
        return null;
      default:
        return "Selecione o tipo da chave Pix.";
    }
  }

  function getPixKeyPlaceholder(type) {
    switch (type) {
      case "phone":
        return "(11)98822-9911";
      case "email":
        return "nome@email.com";
      case "cpf":
        return "123.456.789-09";
      case "cnpj":
        return "12.345.678/0001-95";
      case "random":
        return "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
      default:
        return "Selecione o tipo da chave Pix";
    }
  }

  function getPixKeyInputMode(type) {
    switch (type) {
      case "phone":
      case "cpf":
      case "cnpj":
        return "numeric";
      case "email":
        return "email";
      default:
        return "text";
    }
  }

  function getPixKeyTypeButtons() {
    return $all("[data-pix-type]");
  }

  function parseCurrency(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    const normalized = raw
      .replace(/\s/g, "")
      .replace(/R\$/gi, "")
      .replace(/\./g, "")
      .replace(",", ".");

    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      return Number.NaN;
    }

    return Number(normalized);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }

  function tlv(id, value) {
    const payloadValue = String(value);
    const length = payloadValue.length;
    if (length > 99) {
      throw new Error(`Campo ${id} excede o limite permitido do BR Code.`);
    }
    return `${id}${String(length).padStart(2, "0")}${payloadValue}`;
  }

  function crc16Emv(input) {
    let crc = 0xffff;

    for (let i = 0; i < input.length; i += 1) {
      crc ^= input.charCodeAt(i) << 8;
      for (let bit = 0; bit < 8; bit += 1) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }

    return crc.toString(16).toUpperCase().padStart(4, "0");
  }

  function buildPixPayload(state) {
    const keyType = state.pixKeyType || "";
    const key = normalizePixKey(keyType, state.pixKeyNormalized || state.chavePix || "");
    const name = sanitizeMerchantName(state.nomeRecebedor);
    const txid = sanitizeTxid(state.txid) || "***";

    if (!keyType) {
      throw new Error("Selecione o tipo da chave Pix.");
    }

    const keyError = validatePixKey(keyType, key);
    if (keyError) {
      throw new Error(keyError);
    }

    if (!name) {
      throw new Error("Informe o nome do recebedor.");
    }

    const merchantAccountInfo = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", key);

    let payload =
      tlv("00", "01") +
      tlv("26", merchantAccountInfo) +
      tlv("52", "0000") +
      tlv("53", CURRENCY);

    if (state.valorFixo) {
      if (!Number.isFinite(state.valorNumerico) || state.valorNumerico <= 0) {
        throw new Error("Informe um valor válido maior que zero.");
      }
      payload += tlv("54", state.valorFormatado);
    }

    payload += tlv("58", "BR");
    payload += tlv("59", name);
    payload += tlv("60", CITY);

    if (txid) {
      payload += tlv("62", tlv("05", txid));
    }

    const withCrc = `${payload}6304`;
    const crc = crc16Emv(withCrc);
    const finalPayload = `${withCrc}${crc}`;

    return {
      payload: finalPayload,
      payloadWithoutCrc: withCrc,
      merchantName: name,
      txid: txid || "***",
      chavePix: key,
      pixKeyType: keyType,
      pixKeyNormalized: key,
    };
  }

  function getContrastRatio(hexA, hexB) {
    function luminance(hex) {
      const normalized = hex.replace("#", "");
      const r = parseInt(normalized.slice(0, 2), 16) / 255;
      const g = parseInt(normalized.slice(2, 4), 16) / 255;
      const b = parseInt(normalized.slice(4, 6), 16) / 255;
      const channels = [r, g, b].map((channel) =>
        channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    const l1 = luminance(hexA);
    const l2 = luminance(hexB);
    const bright = Math.max(l1, l2);
    const dark = Math.min(l1, l2);
    return (bright + 0.05) / (dark + 0.05);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Não foi possível ler a imagem enviada."));
      reader.readAsDataURL(file);
    });
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setNotice(message, tone = "") {
    const el = document.getElementById("notice");
    if (!el) return;
    el.textContent = message;
    el.dataset.visible = message ? "true" : "false";
    el.dataset.tone = tone;
  }

  function setFieldError(id, message) {
    const errorEl = document.querySelector(`[data-error-for="${id}"]`);
    const input = document.getElementById(id);
    if (errorEl) errorEl.textContent = message || "";
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function clearErrors() {
    $all("[data-error-for]").forEach((node) => {
      node.textContent = "";
    });
    $all("[aria-invalid='true']").forEach((node) => {
      node.setAttribute("aria-invalid", "false");
    });
    setNotice("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getPixKeyTypeLabel(type) {
    switch (type) {
      case "phone":
        return "Telefone";
      case "email":
        return "E-mail";
      case "cpf":
        return "CPF";
      case "cnpj":
        return "CNPJ";
      case "random":
        return "Chave aleatória";
      default:
        return "Chave Pix";
    }
  }

  function setSelectedPixKeyType(type, { keepValue = false } = {}) {
    const normalizedType = PIX_KEY_TYPES.includes(type) ? type : "";
    const input = $("#chave_pix");

    getPixKeyTypeButtons().forEach((button) => {
      const isActive = button.dataset.pixType === normalizedType;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    });

    if (input) {
      input.placeholder = getPixKeyPlaceholder(normalizedType);
      input.inputMode = getPixKeyInputMode(normalizedType);
      if (!keepValue) {
        input.value = "";
      }
      input.setAttribute("aria-invalid", "false");
    }

    const hint = $("#pix_key_hint");
    if (hint) {
      hint.textContent = normalizedType
        ? `Tipo selecionado: ${getPixKeyTypeLabel(normalizedType)}. Digite a chave e saia do campo para validar.`
        : "Escolha o tipo de chave Pix para liberar a validação.";
    }

    if (!normalizedType) {
      setFieldError("pix_key_type", "Selecione o tipo da chave Pix.");
    } else {
      setFieldError("pix_key_type", "");
    }

    const current = readState() || {};
    current.pixKeyType = normalizedType;
    current.pixKeyNormalized = keepValue ? current.pixKeyNormalized || "" : "";
    current.pixKeyInput = keepValue ? current.pixKeyInput || "" : "";
    if (!keepValue) {
      current.chavePix = "";
    }
    writeState(current);
  }

  function getSelectedPixKeyType() {
    const active = getPixKeyTypeButtons().find((button) => button.classList.contains("is-active"));
    if (active) {
      return active.dataset.pixType || "";
    }
    const state = readState() || {};
    return state.pixKeyType || "";
  }

  function normalizeCurrentPixKey() {
    const type = getSelectedPixKeyType();
    const input = $("#chave_pix");

    if (!type) {
      setFieldError("pix_key_type", "Selecione o tipo da chave Pix.");
      updateGenerateButtonState();
      return { valid: false, normalizedValue: "", type: "", error: "Selecione o tipo da chave Pix." };
    }

    const rawValue = input ? input.value : "";
    const normalizedValue = normalizePixKey(type, rawValue);
    const displayValue = getPixKeyDisplayValue(type, rawValue || normalizedValue);
    const error = validatePixKey(type, normalizedValue);

    if (error) {
      setFieldError("chave_pix", error);
      if (input) input.setAttribute("aria-invalid", "true");
      updateGenerateButtonState();
      return { valid: false, normalizedValue, type, error };
    }

    if (input) {
      input.value = displayValue;
      input.setAttribute("aria-invalid", "false");
    }
    setFieldError("chave_pix", "");

    const current = readState() || {};
    current.pixKeyType = type;
    current.pixKeyInput = displayValue;
    current.pixKeyNormalized = normalizedValue;
    writeState(current);

    updateGenerateButtonState();
    return { valid: true, normalizedValue, type, error: null };
  }

  function updateGenerateButtonState() {
    const button = $("#generate_qr");
    if (!button) return;

    const type = getSelectedPixKeyType();
    const name = sanitizeMerchantName(getInputValue("nome_recebedor"));
    const input = $("#chave_pix");
    const normalizedKey = type && input ? normalizePixKey(type, input.value) : "";
    const keyError = type ? validatePixKey(type, normalizedKey) : "Selecione o tipo da chave Pix.";

    let valueError = null;
    const mode = (readState() || {}).valorMode || ($("#mode_free")?.classList.contains("is-active") ? "free" : "fixed");
    if (mode !== "free") {
      const rawValue = getInputValue("valor_pix");
      if (rawValue.trim()) {
        const numeric = parseCurrency(rawValue);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          valueError = "Digite um valor válido maior que zero.";
        }
      }
    }

    button.disabled = !type || Boolean(keyError) || !name || Boolean(valueError);
  }

  function syncDraft(extra = {}) {
    const current = readState() || {};
    const draft = {
      ...current,
      ...extra,
      pixKeyType: getSelectedPixKeyType(),
      chavePix: getInputValue("chave_pix"),
      pixKeyInput: getInputValue("chave_pix"),
      pixKeyNormalized: Object.prototype.hasOwnProperty.call(extra, "pixKeyNormalized")
        ? extra.pixKeyNormalized
        : current.pixKeyNormalized || "",
      nomeRecebedor: getInputValue("nome_recebedor"),
      valor: getInputValue("valor_pix"),
      txid: getInputValue("txid_pix"),
      qrColor: getInputValue("qr_color"),
      bgColor: getInputValue("bg_color"),
      includeLogo: Boolean($("#include_logo")?.checked),
    };

    if (Object.prototype.hasOwnProperty.call(extra, "logoDataUrl")) {
      draft.logoDataUrl = extra.logoDataUrl;
      draft.logoName = extra.logoName || "";
      draft.logoSize = extra.logoSize || 0;
    }

    writeState(draft);
  }

  function applyFormState(state) {
    if (!state) return;

    if (state.pixKeyType) {
      setSelectedPixKeyType(state.pixKeyType, { keepValue: true });
    } else {
      setSelectedPixKeyType("");
    }

    if ($("#chave_pix") && typeof (state.pixKeyInput || state.chavePix || state.pixKeyNormalized) === "string") {
      $("#chave_pix").value = state.pixKeyInput || state.chavePix || state.pixKeyNormalized;
    }
    if ($("#nome_recebedor") && typeof state.nomeRecebedor === "string") $("#nome_recebedor").value = state.nomeRecebedor;
    if ($("#valor_pix") && typeof state.valor === "string") $("#valor_pix").value = state.valor;
    if ($("#txid_pix") && typeof state.txid === "string") $("#txid_pix").value = state.txid;
    if ($("#qr_color") && typeof state.qrColor === "string") $("#qr_color").value = state.qrColor;
    if ($("#bg_color") && typeof state.bgColor === "string") $("#bg_color").value = state.bgColor;
    if ($("#include_logo")) $("#include_logo").checked = Boolean(state.includeLogo);
    if (state.logoDataUrl && $("#include_logo")) $("#include_logo").checked = true;
    syncLogoConfigVisibility();

    if (state.logoDataUrl) {
      setLogoPreview(state.logoName || "Logo enviada", state.logoSize || 0);
    }
  }

  function setLogoPreview(name, size) {
    const preview = $("#logo_preview");
    if (!preview) return;
    const sizeLabel = size ? `${(size / 1024).toFixed(1)} KB` : "";
    preview.innerHTML = `
      <div class="file-badge">IMG</div>
      <div class="file-meta">
        <p class="file-name">${escapeHtml(name)}</p>
        <p class="file-size">${sizeLabel ? `Arquivo carregado: ${sizeLabel}` : "Arquivo carregado"}</p>
      </div>
    `;
    preview.hidden = false;
  }

  function clearLogoPreview() {
    const preview = $("#logo_preview");
    if (!preview) return;
    preview.hidden = true;
    preview.innerHTML = "";
  }

  function syncLogoConfigVisibility() {
    const includeLogo = $("#include_logo");
    const config = $("#logo_config");
    if (!includeLogo || !config) return;
    config.classList.toggle("is-hidden", !includeLogo.checked);
  }

  async function handleLogoChange(event) {
    const input = event.target;
    const file = input.files && input.files[0];

    if (!file) {
      clearLogoPreview();
      if ($("#include_logo")) {
        $("#include_logo").checked = false;
        syncLogoConfigVisibility();
      }
      const current = readState() || {};
      delete current.logoDataUrl;
      delete current.logoName;
      delete current.logoSize;
      current.includeLogo = Boolean($("#include_logo")?.checked);
      writeState(current);
      return;
    }

    if (!file.type.startsWith("image/")) {
      input.value = "";
      setNotice("Envie uma imagem válida no formato PNG, JPEG, WEBP, GIF, AVIF ou SVG.", "error");
      return;
    }

    if (file.size > MAX_LOGO_BYTES) {
      input.value = "";
      setNotice("A logo deve ter no máximo 1,5 MB para preservar o armazenamento e a leitura do QR.", "error");
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      if ($("#include_logo")) {
        $("#include_logo").checked = true;
        syncLogoConfigVisibility();
      }
      setLogoPreview(file.name, file.size);
      syncDraft({
        logoDataUrl: dataUrl,
        logoName: file.name,
        logoSize: file.size,
      });
      setNotice("Logo carregada. O QR será gerado com margem segura e erro de correção alto.", "success");
    } catch (error) {
      setNotice(error.message || "Não foi possível ler a imagem enviada.", "error");
      input.value = "";
    }
  }

  function setMode(mode) {
    const modeFixed = mode === "fixed";
    const fixedButton = $("#mode_fixed");
    const freeButton = $("#mode_free");
    const valueField = $("#valor_pix");
    const valueRow = $("#valor_row");

    if (fixedButton) fixedButton.classList.toggle("is-active", modeFixed);
    if (freeButton) freeButton.classList.toggle("is-active", !modeFixed);
    if (valueField) valueField.disabled = !modeFixed;
    if (valueRow) valueRow.classList.toggle("is-hidden", !modeFixed);
    if (!modeFixed && valueField) valueField.value = "";

    const current = readState() || {};
    current.valorMode = modeFixed ? "fixed" : "free";
    if (!modeFixed) {
      current.valor = "";
    }
    writeState(current);
    updateGenerateButtonState();
  }

  function validateColors(qrColor, bgColor) {
    const ratio = getContrastRatio(qrColor, bgColor);
    if (ratio < 4.5) {
      throw new Error("A cor do QR e a cor de fundo precisam ter contraste alto para manter a leitura.");
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    clearErrors();

    const currentType = getSelectedPixKeyType();
    if (!currentType) {
      setFieldError("pix_key_type", "Selecione o tipo da chave Pix.");
      setNotice("Selecione o tipo da chave Pix antes de gerar o QR Code.", "error");
      return;
    }

    const normalizedKeyResult = normalizeCurrentPixKey();
    if (!normalizedKeyResult.valid) {
      setNotice(normalizedKeyResult.error || "Revise a chave Pix antes de continuar.", "error");
      return;
    }

    const rawState = readState() || {};
    const mode = rawState.valorMode || ($("#mode_free")?.classList.contains("is-active") ? "free" : "fixed");
    const valorTexto = getInputValue("valor_pix");
    const valorNumerico = parseCurrency(valorTexto);
    const qrColor = getInputValue("qr_color") || "#111111";
    const bgColor = getInputValue("bg_color") || "#ffffff";
    const nomeRecebedor = getInputValue("nome_recebedor");
    const txidSanitized = sanitizeTxid(getInputValue("txid_pix"));

    const draft = {
      pixKeyType: currentType,
      chavePix: normalizedKeyResult.normalizedValue,
      pixKeyNormalized: normalizedKeyResult.normalizedValue,
      nomeRecebedor,
      valor: valorTexto,
      txid: txidSanitized || "***",
      qrColor,
      bgColor,
      includeLogo: Boolean($("#include_logo")?.checked),
      logoDataUrl: rawState.logoDataUrl || "",
      logoName: rawState.logoName || "",
      logoSize: rawState.logoSize || 0,
      valorMode: mode,
    };

    if (!sanitizeMerchantName(nomeRecebedor)) {
      setFieldError("nome_recebedor", "Informe o nome do recebedor.");
      setNotice("Informe o nome do recebedor.", "error");
      return;
    }

    if (draft.valor.trim()) {
      if (!Number.isFinite(valorNumerico) || valorNumerico <= 0) {
        setFieldError("valor_pix", "Digite um valor válido maior que zero.");
        setNotice("Digite um valor válido maior que zero.", "error");
        return;
      }
    }

    if (draft.includeLogo && !draft.logoDataUrl) {
      setNotice("Você marcou logo, mas ainda não enviou nenhuma imagem.", "error");
      return;
    }

    try {
      validateColors(qrColor, bgColor);
      const payloadData = buildPixPayload({
        ...draft,
        valorFixo: mode === "fixed" && draft.valor.trim() !== "",
        valorNumerico,
        valorFormatado: Number.isFinite(valorNumerico) ? valorNumerico.toFixed(2) : "",
      });

      writeState({
        ...draft,
        payload: payloadData.payload,
        payloadWithoutCrc: payloadData.payloadWithoutCrc,
        merchantName: payloadData.merchantName,
        txid: payloadData.txid,
        chavePix: payloadData.chavePix,
        pixKeyType: payloadData.pixKeyType,
        pixKeyNormalized: payloadData.pixKeyNormalized,
        valorFixo: mode === "fixed" && draft.valor.trim() !== "",
        valorNumerico,
        valorFormatado: Number.isFinite(valorNumerico) ? valorNumerico.toFixed(2) : "",
        generatedAt: new Date().toISOString(),
        appVersion: "1.0",
      });

      window.location.href = "resultado.html";
    } catch (error) {
      setNotice(error.message || "Não foi possível gerar o QR Code.", "error");
    }
  }

  function handleCopyText(text, statusSelector) {
    const success = () => {
      if (statusSelector) {
        const status = document.querySelector(statusSelector);
        if (status) {
          status.textContent = "Copiado para a área de transferência.";
          status.dataset.tone = "success";
        }
      }
    };

    const fallback = () => {
      const fallbackInput = document.createElement("textarea");
      fallbackInput.value = text;
      fallbackInput.setAttribute("readonly", "true");
      fallbackInput.style.position = "fixed";
      fallbackInput.style.opacity = "0";
      document.body.appendChild(fallbackInput);
      fallbackInput.select();
      document.execCommand("copy");
      document.body.removeChild(fallbackInput);
      success();
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).then(success, fallback);
    }

    fallback();
    return Promise.resolve();
  }

  function mountFormPage() {
    const form = $("#pix_form");
    if (!form) return;

    const state = readState();
    applyFormState(state);

    const savedMode = state && state.valorMode === "free" ? "free" : "fixed";
    setMode(savedMode);
    syncLogoConfigVisibility();

    getPixKeyTypeButtons().forEach((button) => {
      button.addEventListener("click", () => {
        clearErrors();
        setSelectedPixKeyType(button.dataset.pixType || "");
        updateGenerateButtonState();
        syncDraft();
        const input = $("#chave_pix");
        if (input) {
          input.focus();
        }
      });
    });

    const keyInput = $("#chave_pix");
    if (keyInput) {
      keyInput.addEventListener("input", () => {
        clearErrors();
        syncDraft();
        updateGenerateButtonState();
      });
      keyInput.addEventListener("blur", () => {
        const result = normalizeCurrentPixKey();
        if (result.valid) {
          syncDraft({ pixKeyNormalized: result.normalizedValue, chavePix: result.normalizedValue });
        }
      });
      keyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          normalizeCurrentPixKey();
        }
      });
    }

    ["nome_recebedor", "valor_pix", "txid_pix", "qr_color", "bg_color"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        clearErrors();
        syncDraft();
        updateGenerateButtonState();
      });
    });

    const nameField = $("#nome_recebedor");
    const txidField = $("#txid_pix");
    if (nameField) {
      nameField.addEventListener("blur", () => {
        nameField.value = sanitizeMerchantName(nameField.value);
        syncDraft();
        updateGenerateButtonState();
      });
    }
    if (txidField) {
      txidField.addEventListener("blur", () => {
        txidField.value = sanitizeTxid(txidField.value);
        syncDraft();
        updateGenerateButtonState();
      });
    }

    const logoInput = $("#logo_pix");
    if (logoInput) {
      logoInput.addEventListener("change", handleLogoChange);
    }

    const includeLogo = $("#include_logo");
    if (includeLogo) {
      includeLogo.addEventListener("change", () => {
        syncDraft({ includeLogo: includeLogo.checked });
        syncLogoConfigVisibility();
      });
    }

    const fixedButton = $("#mode_fixed");
    const freeButton = $("#mode_free");
    if (fixedButton) {
      fixedButton.addEventListener("click", () => setMode("fixed"));
    }
    if (freeButton) {
      freeButton.addEventListener("click", () => setMode("free"));
    }

    const clearButton = $("#clear_form");
    if (clearButton) {
      clearButton.addEventListener("click", () => {
        clearState();
        form.reset();
        clearErrors();
        clearLogoPreview();
        setSelectedPixKeyType("");
        syncLogoConfigVisibility();
        setMode("fixed");
        updateGenerateButtonState();
      });
    }

    form.addEventListener("submit", handleGenerate);
    updateGenerateButtonState();
  }

  function renderQRCode(result) {
    if (!window.QRCodeStyling) {
      throw new Error("A biblioteca do QR não carregou corretamente.");
    }

    const container = document.getElementById("qr_container");
    if (!container) return null;

    container.innerHTML = "";

    const qr = new window.QRCodeStyling({
      width: 320,
      height: 320,
      type: "canvas",
      data: result.payload,
      margin: 12,
      qrOptions: {
        errorCorrectionLevel: "H",
      },
      dotsOptions: {
        color: result.qrColor,
        type: "square",
      },
      cornersSquareOptions: {
        color: result.qrColor,
        type: "square",
      },
      cornersDotOptions: {
        color: result.qrColor,
        type: "square",
      },
      backgroundOptions: {
        color: result.bgColor,
      },
      image: result.includeLogo ? result.logoDataUrl || "" : "",
      imageOptions: {
        crossOrigin: "anonymous",
        margin: 8,
        imageSize: 0.18,
        hideBackgroundDots: true,
      },
    });

    qr.append(container);
    return qr;
  }

  function fillResultPage() {
    const state = readState();
    if (!state || !state.payload) {
      window.location.replace("index.html");
      return;
    }

    setText("result_name", state.merchantName || sanitizeMerchantName(state.nomeRecebedor || ""));
    setText("result_key", state.chavePix || "-");
    setText("result_txid", state.txid || "***");
    setText("result_value", state.valorFixo ? formatCurrency(state.valorNumerico) : "Valor livre");
    setText("result_mode", state.valorFixo ? "Valor fixo" : "Valor livre");
    setText("result_status", state.valorFixo ? "O pagador verá o valor definido." : "O banco vai permitir digitação do valor.");
    setText("payload_text", state.payload);
    setText("payload_length", `${state.payload.length} caracteres`);
    setText("merchant_city", CITY);
    setText("merchant_country", "BR");

    let qr = null;
    try {
      qr = renderQRCode(state);
    } catch (error) {
      const container = document.getElementById("qr_container");
      if (container) {
        container.innerHTML = `
          <div style="display:grid; place-items:center; width:100%; height:100%; text-align:center; padding:16px; color:#5f6b82; font-size:14px; line-height:1.5;">
            <span>Não foi possível renderizar o QR automaticamente.</span>
            <span style="margin-top:8px; font-family:var(--mono); font-size:12px;">${escapeHtml(error.message || "Falha na biblioteca do QR.")}</span>
          </div>
        `;
      }
    }

    const copyButton = $("#copy_payload");
    const downloadButton = $("#download_qr");
    const backButton = $("#back_to_form");
    const copyStatus = $("#copy_status");

    if (copyButton) {
      copyButton.addEventListener("click", () => {
        handleCopyText(state.payload, "#copy_status");
        if (copyStatus) {
          copyStatus.textContent = "Copiando payload...";
          copyStatus.dataset.tone = "success";
          window.setTimeout(() => {
            copyStatus.textContent = "Copiado para a área de transferência.";
          }, 350);
        }
      });
    }

    if (downloadButton && qr) {
      downloadButton.addEventListener("click", async () => {
        try {
          await qr.download({
            name: "pix-brcode",
            extension: "png",
          });
        } catch (error) {
          setText("download_status", error.message || "Não foi possível baixar o QR.");
        }
      });
    }

    if (backButton) {
      backButton.addEventListener("click", () => {
        window.location.href = "index.html";
      });
    }
  }

  function mountResultPage() {
    fillResultPage();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.dataset.page;
    if (page === "form") {
      mountFormPage();
    }
    if (page === "result") {
      mountResultPage();
    }

    const copyPayload = $("#copy_payload_inline");
    if (copyPayload) {
      copyPayload.addEventListener("click", () => {
        const payload = $("#payload_text")?.textContent || "";
        if (payload) {
          handleCopyText(payload, "#copy_status");
        }
      });
    }
  });
})();
