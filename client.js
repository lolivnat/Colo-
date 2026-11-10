const serviceLabels = {
  parto: "Acompanhamento no parto",
  gestacao: "Apoio na gestação",
  "pos-parto": "Pós-parto e amamentação",
  online: "Atendimento online"
};
const favoritesStorageKey = "colo.favorites.v1";
const grid = document.querySelector("#doula-grid");
const searchForm = document.querySelector("#search-form");
const locationFilter = document.querySelector("#location-filter");
const serviceFilter = document.querySelector("#service-filter");
const sortFilter = document.querySelector("#sort-filter");
const dialog = document.querySelector("#profile-dialog");
const dialogContent = document.querySelector("#profile-dialog-content");
const toast = document.querySelector("#toast");
let currentUser = null;
let pendingContactId = "";
let toastTimeout;

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Não foi possível concluir a solicitação.");
  return result;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3500);
}

function updateHeader() {
  document.querySelector("#messages-button").hidden = !currentUser;
  document.querySelector("#contacts-button").hidden = currentUser?.role !== "doula";
  document.querySelector("#billing-button").hidden = currentUser?.role !== "doula";
  document.querySelector("#admin-payments-button").hidden = !currentUser?.isAdmin;
  document.querySelector("#create-profile-button").innerHTML = `${currentUser ? "Meu perfil" : "Entrar / cadastrar"} <span aria-hidden="true">↗</span>`;
}

function showError(container, message) {
  const error = container.querySelector("#form-error");
  if (!error) {
    showToast(message);
    return;
  }
  error.textContent = message;
  error.hidden = false;
}

function openDialog() {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog() {
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function getFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(favoritesStorageKey) || "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    showToast("Não foi possível carregar favoritos salvos neste navegador.");
    return [];
  }
}

async function renderDoulas() {
  const params = new URLSearchParams({
    city: locationFilter.value.trim(),
    service: serviceFilter.value,
    sort: sortFilter.value
  });
  grid.innerHTML = `<div class="empty-state" aria-live="polite">Buscando profissionais...</div>`;
  try {
    const { doulas } = await api(`/api/doulas?${params}`);
    document.querySelector("#results-count").textContent = `${doulas.length} ${doulas.length === 1 ? "doula disponível" : "doulas disponíveis"}`;
    document.querySelector("#location-summary").textContent = locationFilter.value.trim()
      ? `Resultados para ${locationFilter.value.trim()}`
      : "Doulas para conhecer";

    if (doulas.length === 0) {
      grid.innerHTML = `<div class="empty-state"><strong>Ainda não encontramos esse apoio.</strong>Quando profissionais publicarem seus perfis, você poderá encontrá-las por cidade e serviço.<br><button type="button" data-clear-search>Limpar busca</button></div>`;
      return;
    }

    const favorites = getFavorites();
    grid.innerHTML = doulas.map((doula) => {
      const tags = doula.services.map((service) => `<span class="tag">${escapeHtml(serviceLabels[service] || service)}</span>`).join("");
      const isFavorite = favorites.includes(doula.id);
      const place = [doula.neighborhood, doula.city].filter(Boolean).map(escapeHtml).join(", ");
      const price = doula.priceCents == null ? "Consulte valores" : `A partir de <strong>${formatCurrency(doula.priceCents)}</strong>`;
      return `
        <article class="doula-card">
          <div class="card-cover cover-sage">
            <span class="cover-shape" aria-hidden="true"></span>
            <span class="cover-decor" aria-hidden="true">✳</span>
            <button class="favorite-button${isFavorite ? " is-favorite" : ""}" type="button" aria-label="${isFavorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}: ${escapeHtml(doula.name)}" aria-pressed="${isFavorite}" data-favorite="${escapeHtml(doula.id)}">${isFavorite ? "♥" : "♡"}</button>
            <span class="avatar avatar-sage" aria-hidden="true">${escapeHtml(getInitials(doula.name))}</span>
          </div>
          <div class="card-content">
            <div class="card-name-row"><h3 class="card-name">${escapeHtml(doula.name)}</h3>${doula.isPremium ? `<span class="premium-badge">Premium</span>` : ""}</div>
            <p class="card-location"><span aria-hidden="true">⌖</span> ${place || "Localização não informada"}</p>
            <p class="card-bio">${escapeHtml(doula.about || "Conheça os serviços e o jeito de cuidar desta profissional.")}</p>
            <div class="card-tags">${tags}</div>
            <div class="card-divider"></div>
            <div class="card-bottom"><span class="card-price">${price}</span><button class="profile-link" type="button" data-profile="${escapeHtml(doula.id)}">Ver perfil <span aria-hidden="true">→</span></button></div>
          </div>
        </article>`;
    }).join("");
  } catch (error) {
    grid.innerHTML = `<div class="empty-state"><strong>Não foi possível carregar os perfis.</strong>${escapeHtml(error.message)}<br><button type="button" data-retry> Tentar novamente</button></div>`;
    document.querySelector("#results-count").textContent = "Busca indisponível";
  }
}

function getInitials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toLocaleUpperCase("pt-BR");
}

function renderAuthForm(mode = "register", role = "gestante") {
  const registering = mode === "register";
  dialogContent.innerHTML = `
    <span class="dialog-kicker">Bem-vinda à rede colo</span>
    <h2 class="dialog-title" id="profile-dialog-title">${registering ? "Vamos nos conhecer?" : "Que bom ter você de volta."}</h2>
    <p class="dialog-intro">${registering ? "Crie uma conta para encontrar apoio ou apresentar seu trabalho." : "Entre para acessar seu perfil e suas conversas."}</p>
    <form class="profile-form" id="auth-form" data-mode="${mode}" novalidate>
      ${registering ? `
        <div class="role-switch" role="group" aria-label="Tipo de conta">
          <button class="role-option" type="button" data-role="gestante" aria-pressed="${role === "gestante"}">Sou gestante</button>
          <button class="role-option" type="button" data-role="doula" aria-pressed="${role === "doula"}">Sou doula</button>
        </div>
        <input type="hidden" name="role" value="${role}">
      ` : ""}
      <label class="form-field">E-mail<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="voce@email.com"></label>
      <label class="form-field">Senha<input name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" minlength="12" maxlength="128" required placeholder="${registering ? "Pelo menos 12 caracteres" : "Sua senha"}"></label>
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="button button-coral profile-submit" type="submit">${registering ? "Criar conta" : "Entrar"} <span aria-hidden="true">→</span></button>
    </form>
    <p class="auth-switch">${registering ? "Já tem uma conta?" : "Ainda não tem uma conta?"} <button type="button" data-auth-mode="${registering ? "login" : "register"}">${registering ? "Entrar" : "Criar conta"}</button></p>`;
  openDialog();
}

function profileView(profile) {
  const place = [profile.neighborhood, profile.city].filter(Boolean).map(escapeHtml).join(", ");
  const roleName = currentUser.role === "doula" ? "Doula" : "Gestante";
  const sections = currentUser.role === "doula"
    ? [
      ["Sobre", profile.about],
      ["Serviços oferecidos", (profile.services || []).map((service) => serviceLabels[service] || service).join(" · ")],
      ["Atendimento", profile.serviceMode],
      ["Experiência", profile.experienceYears == null ? "" : `${profile.experienceYears} anos`],
      ["Valor inicial", profile.priceCents == null ? "" : formatCurrency(profile.priceCents)],
      ["Link de pagamento externo", profile.paymentUrl]
    ]
    : [
      ["Sobre você", profile.about],
      ["Sobre a gestação", [
        profile.pregnancyWeeks ? `${profile.pregnancyWeeks} semanas` : "",
        profile.dueDate ? `Data prevista: ${profile.dueDate}` : "",
        profile.preferences
      ].filter(Boolean).join("\n")],
      ["Localização", place],
      ["Diretório de contato", profile.directoryOptIn ? "Autorizado" : "Privado"],
      ["Compartilhar e-mail", profile.contactSharingOptIn ? "Autorizado para doulas pagantes" : "Privado"]
    ];
  dialogContent.innerHTML = `
    <span class="dialog-kicker">Seu espaço de cuidado</span>
    <h2 class="dialog-title" id="profile-dialog-title">Meu perfil</h2>
    <p class="dialog-intro">${escapeHtml(currentUser.email)} · ${roleName}${place ? ` · ${place}` : ""}</p>
    ${sections.filter(([, content]) => content).map(([title, content]) => `<section class="saved-profile-section"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(content)}</p></section>`).join("")}
    ${currentUser.role === "doula" ? `<p class="form-helper">${profile.published ? "Seu perfil está público e pode aparecer nas buscas." : "Seu perfil não está público. Edite-o para escolher se deseja aparecer nas buscas."}</p>` : `<p class="form-helper">Seu perfil e as informações da gestação não aparecem nas buscas. Compartilhe apenas o que desejar nas conversas.</p>`}
    <div class="profile-actions"><button class="button button-outline" type="button" data-edit-profile>Editar perfil</button>${currentUser.role === "doula" ? `<button class="button button-coral" type="button" data-billing>Plano e contatos</button>` : ""}<button class="button button-outline" type="button" data-logout>Sair</button></div>
    ${currentUser.isAdmin ? `<button class="account-delete" type="button" data-admin-payments>Revisar comprovantes</button>` : ""}
    <button class="account-delete" type="button" data-delete-account>Apagar minha conta e meus dados</button>`;
  openDialog();
}

function profileForm(profile = null) {
  if (!currentUser) return renderAuthForm();
  const isDoula = currentUser.role === "doula";
  const selectedServices = new Set(profile?.services || []);
  dialogContent.innerHTML = `
    <span class="dialog-kicker">${profile ? "Seu espaço de cuidado" : "Complete seu perfil"}</span>
    <h2 class="dialog-title" id="profile-dialog-title">${isDoula ? "Apresente seu trabalho." : "Vamos nos conhecer?"}</h2>
    <p class="dialog-intro">${isDoula ? "Conte às gestantes como você pode apoiá-las." : "Estas informações são privadas e não aparecem para doulas sem seu consentimento."}</p>
    <form class="profile-form" id="profile-form" novalidate>
      <label class="form-field">Seu nome<input name="name" autocomplete="name" maxlength="80" required placeholder="Como podemos chamar você?" value="${escapeHtml(profile?.name === "Perfil novo" ? "" : profile?.name || "")}"></label>
      <div class="form-grid">
        <label class="form-field">Cidade<input name="city" autocomplete="address-level2" maxlength="100" required placeholder="Ex.: São Paulo" value="${escapeHtml(profile?.city === "A definir" ? "" : profile?.city || "")}"></label>
        <label class="form-field">Bairro<input name="neighborhood" maxlength="100" placeholder="Ex.: Pinheiros" value="${escapeHtml(profile?.neighborhood || "")}"></label>
      </div>
      ${isDoula ? `
        <label class="form-field">Conte um pouco sobre seu trabalho<textarea name="about" maxlength="600" required placeholder="Sua experiência, seu jeito de cuidar...">${escapeHtml(profile?.about || "")}</textarea></label>
        <fieldset class="service-fieldset"><legend>Serviços oferecidos</legend><div class="service-options">
          ${Object.entries(serviceLabels).map(([key, label]) => `<label><input type="checkbox" name="services" value="${key}" ${selectedServices.has(key) ? "checked" : ""}> ${label}</label>`).join("")}
        </div></fieldset>
        <div class="form-grid">
          <label class="form-field">Formato de atendimento<input name="serviceMode" maxlength="120" placeholder="Ex.: presencial e online" value="${escapeHtml(profile?.serviceMode || "")}"></label>
          <label class="form-field">Anos de experiência<input name="experienceYears" type="number" min="0" max="80" step="1" placeholder="Ex.: 5" value="${escapeHtml(profile?.experienceYears ?? "")}"></label>
        </div>
        <div class="form-grid">
          <label class="form-field">Valor inicial (R$)<input name="price" type="number" min="0" max="1000000" step="0.01" placeholder="Ex.: 500" value="${profile?.priceCents == null ? "" : escapeHtml((profile.priceCents / 100).toFixed(2))}"></label>
          <label class="form-field">Link de pagamento externo<input name="paymentUrl" type="url" maxlength="500" placeholder="https://..." value="${escapeHtml(profile?.paymentUrl || "")}"></label>
        </div>
        <label class="publish-option"><input name="published" type="checkbox" ${profile?.published ? "checked" : ""}> Publicar meu perfil nas buscas</label>
        <p class="form-helper">Ao publicar, seu nome, cidade, bairro, apresentação, serviços e valores poderão ser vistos por qualquer pessoa. Informações sobre gestação nunca aparecem aqui.</p>
      ` : `
        <label class="form-field">Um pouco sobre você<textarea name="about" maxlength="600" placeholder="O que você gostaria que sua doula soubesse?">${escapeHtml(profile?.about || "")}</textarea></label>
        <div class="form-grid">
          <label class="form-field">Semanas de gestação<input name="pregnancyWeeks" type="number" min="1" max="45" placeholder="Ex.: 24" value="${escapeHtml(profile?.pregnancyWeeks ?? "")}"></label>
          <label class="form-field">Data prevista do parto<input name="dueDate" type="date" value="${escapeHtml(profile?.dueDate || "")}"></label>
        </div>
        <label class="form-field">O que busca neste momento?<textarea name="preferences" maxlength="400" placeholder="Ex.: apoio para o parto, escuta, amamentação...">${escapeHtml(profile?.preferences || "")}</textarea></label>
        <fieldset class="service-fieldset privacy-consent">
          <legend>Diretório de contato (opcional)</legend>
          <label><input name="directoryOptIn" type="checkbox" ${profile?.directoryOptIn ? "checked" : ""}> Quero aparecer no diretório privado de doulas que tiveram o pagamento aprovado. Elas poderão ver meu nome, cidade e bairro. Minha gestação permanece privada.</label>
          <label><input name="contactSharingOptIn" type="checkbox" ${profile?.contactSharingOptIn ? "checked" : ""} ${profile?.directoryOptIn ? "" : "disabled"}> Autorizo compartilhar meu e-mail com essas doulas para que possam entrar em contato comigo.</label>
        </fieldset>
        <p class="form-helper">As opções são voluntárias e podem ser desativadas a qualquer momento. Sem autorização para compartilhar e-mail, seu contato não aparece. Semanas, data prevista e preferências da gestação nunca são incluídas no diretório.</p>
      `}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="button button-coral profile-submit" type="submit">Salvar perfil <span aria-hidden="true">→</span></button>
    </form>`;
  openDialog();
}

function showDoulaProfile(doula) {
  const place = [doula.neighborhood, doula.city].filter(Boolean).map(escapeHtml).join(", ");
  const services = (doula.services || []).map((service) => serviceLabels[service] || service).join(" · ");
  const price = doula.priceCents == null ? "Consulte valores com a profissional." : `A partir de ${formatCurrency(doula.priceCents)}.`;
  const payment = doula.paymentUrl
    ? `<a class="external-payment" href="${escapeHtml(doula.paymentUrl)}" target="_blank" rel="noopener noreferrer">Abrir link seguro de pagamento externo ↗</a>`
    : "";
  const contactButton = currentUser?.role === "gestante"
    ? `<button class="button button-coral" type="button" data-contact="${escapeHtml(doula.id)}">Conversar com ${escapeHtml(doula.name)} <span aria-hidden="true">→</span></button>`
    : `<button class="button button-coral" type="button" data-contact="${escapeHtml(doula.id)}">${currentUser ? "Entre como gestante para conversar" : "Entre para conversar"} <span aria-hidden="true">→</span></button>`;
  dialogContent.innerHTML = `
    <span class="dialog-kicker">Conheça quem cuida</span>
    <h2 class="dialog-title" id="profile-dialog-title">${escapeHtml(doula.name)}</h2>
    <p class="dialog-intro"><span aria-hidden="true">⌖</span> ${place}</p>
    <section class="saved-profile-section"><h4>Sobre</h4><p>${escapeHtml(doula.about || "Esta profissional ainda não adicionou uma apresentação.")}</p></section>
    <section class="saved-profile-section"><h4>Serviços oferecidos</h4><p>${escapeHtml(services || "Consulte os serviços com a profissional.")}</p></section>
    ${doula.serviceMode ? `<section class="saved-profile-section"><h4>Atendimento</h4><p>${escapeHtml(doula.serviceMode)}</p></section>` : ""}
    ${doula.experienceYears != null ? `<section class="saved-profile-section"><h4>Experiência</h4><p>${escapeHtml(doula.experienceYears)} anos</p></section>` : ""}
    <section class="saved-profile-section"><h4>Investimento</h4><p>${escapeHtml(price)}</p>${payment}</section>
    <p class="form-helper">Os pagamentos são feitos fora do colo, no site do provedor escolhido pela doula. O colo não recebe nem armazena dados de cartão.</p>
    <div class="profile-actions"><button class="button button-outline" type="button" data-close-dialog>Voltar</button>${contactButton}</div>`;
  openDialog();
}

async function renderMessages(conversationId = "") {
  try {
    const { conversations } = await api("/api/conversations");
    if (conversationId) return renderConversation(conversationId);
    dialogContent.innerHTML = `
      <span class="dialog-kicker">Apoio e acolhimento</span>
      <h2 class="dialog-title" id="profile-dialog-title">Minhas conversas</h2>
      ${conversations.length ? `<div class="conversation-list">${conversations.map((conversation) => `
        <button class="conversation-item" type="button" data-conversation="${escapeHtml(conversation.id)}">
          <strong>${escapeHtml(conversation.partner_name || "Contato")}</strong>
          <span>${escapeHtml(conversation.last_message || "Inicie a conversa")}</span>
        </button>`).join("")}</div>` : `<div class="empty-state"><strong>Nenhuma conversa ainda.</strong>Encontre uma doula e envie uma mensagem para iniciar.</div>`}
      <div class="profile-actions"><button class="button button-outline" type="button" data-close-dialog>Fechar</button></div>`;
    openDialog();
  } catch (error) {
    if (error.message.includes("Acesso às conversas bloqueado")) return renderBilling();
    showToast(error.message);
  }
}

function billingStatusLabel(status, active) {
  if (active) return "Pagamento aprovado · acesso liberado";
  if (status === "pending") return "Comprovante enviado · aguardando análise";
  if (status === "rejected") return "Comprovante não aprovado";
  if (status === "approved") return "Acesso expirado · envie o comprovante do novo mês";
  return "Acesso ainda não liberado";
}

async function renderBilling() {
  try {
    const billing = await api("/api/billing");
    const status = billingStatusLabel(billing.status, billing.accessActive);
    const standardPlan = billing.plans.standard;
    const premiumPlan = billing.plans.premium;
    dialogContent.innerHTML = `
      <span class="dialog-kicker">Plano mensal para doulas</span>
      <h2 class="dialog-title" id="profile-dialog-title">Acesse os contatos.</h2>
      <p class="dialog-intro">Os dois planos liberam acesso aos contatos por 30 dias. O Premium também dá prioridade na busca de doulas. A equipe confirma o pagamento antes de ativar o plano.</p>
      <section class="billing-status ${billing.accessActive ? "billing-active" : ""}">
        <strong>${escapeHtml(status)}</strong>
        ${billing.premiumActive ? `<span>Prioridade Premium ativa</span>` : ""}
        ${billing.accessUntil ? `<span>Acesso válido até ${escapeHtml(new Date(billing.accessUntil).toLocaleDateString("pt-BR"))}</span>` : ""}
        ${billing.submittedAt ? `<span>Último envio: ${escapeHtml(new Date(billing.submittedAt).toLocaleString("pt-BR"))}</span>` : ""}
        ${billing.reviewNote ? `<span>${escapeHtml(billing.reviewNote)}</span>` : ""}
      </section>
      <div class="billing-plan-list">
        <div class="billing-plan-option"><strong>Padrão · ${formatCurrency(standardPlan.amountCents)}/mês</strong><span>Acesso aos contatos autorizados</span>${standardPlan.paymentUrl ? `<a href="${escapeHtml(standardPlan.paymentUrl)}" target="_blank" rel="noopener noreferrer">Pagar plano Padrão ↗</a>` : `<span class="form-error">Link de pagamento não configurado.</span>`}</div>
        <div class="billing-plan-option"><strong>Premium · ${formatCurrency(premiumPlan.amountCents)}/mês</strong><span>Prioridade na busca e acesso aos contatos</span>${premiumPlan.paymentUrl ? `<a href="${escapeHtml(premiumPlan.paymentUrl)}" target="_blank" rel="noopener noreferrer">Pagar plano Premium ↗</a>` : `<span class="form-error">Link Premium não configurado.</span>`}</div>
      </div>
      ${billing.canSubmitProof ? `
        <form class="profile-form" id="billing-form">
          <label class="form-field">Plano pago<select name="plan" required><option value="standard" ${billing.plan === "standard" ? "selected" : ""}>Padrão · ${formatCurrency(standardPlan.amountCents)}</option><option value="premium" ${billing.plan === "premium" ? "selected" : ""}>Premium · ${formatCurrency(premiumPlan.amountCents)}</option></select></label>
          <label class="form-field">Imagem do comprovante (JPEG, PNG ou WebP, até 5 MB)<input name="proof" type="file" accept="image/jpeg,image/png,image/webp" required></label>
          <p class="form-helper">O comprovante fica visível apenas para a equipe autorizada durante a análise. Não envie documentos pessoais nem dados de cartão.</p>
          <p class="form-error" id="form-error" role="alert" hidden></p>
          <button class="button button-coral profile-submit" type="submit">Enviar para análise</button>
        </form>
      ` : `<p class="form-helper">Seu comprovante está pendente. Você poderá enviar outro após a análise.</p>`}
      ${billing.accessActive ? `<button class="button button-outline billing-contacts-button" type="button" data-open-contacts>Ver contatos autorizados</button>` : ""}
      <div class="profile-actions"><button class="button button-outline" type="button" data-close-dialog>Fechar</button></div>`;
    openDialog();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderContacts(city = "") {
  try {
    const query = new URLSearchParams({ city });
    const { contacts } = await api(`/api/contacts?${query}`);
    dialogContent.innerHTML = `
      <span class="dialog-kicker">Diretório privado</span>
      <h2 class="dialog-title" id="profile-dialog-title">Contatos autorizados</h2>
      <p class="dialog-intro">Apenas gestantes que escolheram aparecer e compartilhar o e-mail. Semanas, datas e preferências da gestação não são exibidas.</p>
      <form class="contact-search" id="contacts-search"><label class="form-field">Filtrar por cidade ou bairro<input name="city" maxlength="100" value="${escapeHtml(city)}" placeholder="Digite uma cidade ou bairro"></label><button class="button button-outline" type="submit">Buscar</button></form>
      ${contacts.length ? `<div class="conversation-list">${contacts.map((contact) => `
        <article class="contact-item">
          <strong>${escapeHtml(contact.name)}</strong>
          <span>${escapeHtml([contact.neighborhood, contact.city].filter(Boolean).join(", "))}</span>
          <a href="mailto:${encodeURIComponent(contact.email)}">${escapeHtml(contact.email)}</a>
        </article>`).join("")}</div>` : `<div class="empty-state"><strong>Nenhum contato autorizado por enquanto.</strong>Quando gestantes próximas escolherem compartilhar o e-mail, elas aparecerão aqui.</div>`}
      <div class="profile-actions"><button class="button button-outline" type="button" data-close-dialog>Fechar</button><button class="button button-coral" type="button" data-billing>Plano e status</button></div>`;
    openDialog();
  } catch (error) {
    if (error.message.includes("Acesso aos contatos bloqueado")) return renderBilling();
    showToast(error.message);
  }
}

async function renderAdminPayments() {
  try {
    const { submissions } = await api("/api/admin/payments");
    dialogContent.innerHTML = `
      <span class="dialog-kicker">Acesso administrativo</span>
      <h2 class="dialog-title" id="profile-dialog-title">Comprovantes pendentes</h2>
      <p class="dialog-intro">Confira o valor e o plano recebidos antes de liberar 30 dias de acesso. O envio da imagem, sozinho, não confirma pagamento.</p>
      ${submissions.length ? submissions.map((submission) => `
        <article class="review-card" data-submission="${escapeHtml(submission.id)}">
          <strong>${escapeHtml(submission.name || "Doula")}</strong>
          <span>${escapeHtml(submission.email)} · ${escapeHtml(submission.city || "")}</span>
          <span>Enviado em ${escapeHtml(new Date(submission.submitted_at).toLocaleString("pt-BR"))} · ${submission.plan === "premium" ? "Premium" : "Padrão"} · ${formatCurrency(submission.amount_cents)}</span>
          <img class="receipt-preview" src="/api/admin/payments/${encodeURIComponent(submission.id)}/proof" alt="Imagem do comprovante enviado por ${escapeHtml(submission.name || "doula")}" loading="lazy">
          <label class="form-field">Observação da análise<input name="reviewNote" maxlength="500" placeholder="Motivo da rejeição ou observação opcional"></label>
          <div class="profile-actions"><button class="button button-outline" type="button" data-review="rejected" data-id="${escapeHtml(submission.id)}">Rejeitar</button><button class="button button-coral" type="button" data-review="approved" data-id="${escapeHtml(submission.id)}">Confirmar pagamento</button></div>
        </article>`).join("") : `<div class="empty-state"><strong>Nenhum comprovante pendente.</strong>Novos envios aparecerão aqui.</div>`}
      <div class="profile-actions"><button class="button button-outline" type="button" data-close-dialog>Fechar</button></div>`;
    openDialog();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderConversation(id) {
  const [conversationResult, messageResult] = await Promise.all([
    api("/api/conversations"),
    api(`/api/conversations/${encodeURIComponent(id)}/messages`)
  ]);
  const conversation = conversationResult.conversations.find((item) => item.id === id);
  if (!conversation) throw new Error("Conversa não encontrada.");
  dialogContent.innerHTML = `
    <span class="dialog-kicker">Conversa privada</span>
    <h2 class="dialog-title" id="profile-dialog-title">${escapeHtml(conversation.partner_name || "Contato")}</h2>
    <button class="conversation-back" type="button" data-back-messages>← Todas as conversas</button>
    <div class="message-list" aria-live="polite">${messageResult.messages.map((message) => `
      <p class="message-bubble${message.sender_id === currentUser.id ? " message-own" : ""}">${escapeHtml(message.body)}</p>`).join("") || `<p class="empty-messages">Sua conversa começa aqui.</p>`}</div>
    <form class="profile-form message-form" id="message-form" data-conversation="${escapeHtml(id)}">
      <label class="form-field">Mensagem<textarea name="message" maxlength="2000" required placeholder="Escreva sua mensagem..."></textarea></label>
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="button button-coral profile-submit" type="submit">Enviar mensagem <span aria-hidden="true">→</span></button>
    </form>
    <p class="form-helper">Evite compartilhar informações médicas sensíveis ou dados que não deseja dividir.</p>`;
  openDialog();
}

async function startConversationForm(doulaId) {
  if (!currentUser) {
    pendingContactId = doulaId;
    renderAuthForm("login");
    return;
  }
  if (currentUser.role !== "gestante") {
    showToast("Somente uma conta de gestante pode iniciar uma conversa pelo perfil de uma doula.");
    return;
  }
  try {
    const { doula } = await api(`/api/doulas/${encodeURIComponent(doulaId)}`);
    dialogContent.innerHTML = `
      <span class="dialog-kicker">Conexão direta e privada</span>
      <h2 class="dialog-title" id="profile-dialog-title">Escreva para ${escapeHtml(doula.name)}</h2>
      <p class="dialog-intro">Sua mensagem será enviada somente a esta doula. Não é necessário compartilhar informações médicas.</p>
      <form class="profile-form" id="contact-form" data-doula="${escapeHtml(doula.id)}">
        <label class="form-field">Sua mensagem<textarea name="message" maxlength="2000" required placeholder="Olá! Gostaria de saber mais sobre seu trabalho..."></textarea></label>
        <p class="form-error" id="form-error" role="alert" hidden></p>
        <button class="button button-coral profile-submit" type="submit">Enviar mensagem <span aria-hidden="true">→</span></button>
      </form>`;
    openDialog();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshCurrentUser() {
  try {
    const result = await api("/api/me");
    currentUser = result.user;
  } catch (error) {
    currentUser = null;
    if (error.message !== "Entre na sua conta para continuar." && error.message !== "Sua sessão expirou. Entre novamente.") {
      showToast(error.message);
    }
  }
  updateHeader();
}

async function onAuthSubmit(form) {
  const data = new FormData(form);
  const mode = form.dataset.mode;
  const payload = {
    email: String(data.get("email") || "").trim(),
    password: String(data.get("password") || "")
  };
  if (mode === "register") payload.role = String(data.get("role"));
  try {
    await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(payload) });
    await refreshCurrentUser();
    showToast(mode === "register" ? "Conta criada com sucesso." : "Você entrou na sua conta.");
    if (pendingContactId) {
      const doulaId = pendingContactId;
      pendingContactId = "";
      await startConversationForm(doulaId);
      return;
    }
    const { profile } = await api("/api/me");
    if (profile?.name && profile.name !== "Perfil novo") profileView(profile);
    else profileForm(profile);
  } catch (error) {
    showError(dialogContent, error.message);
  }
}

async function onProfileSubmit(form) {
  const data = new FormData(form);
  const payload = {
    name: String(data.get("name") || "").trim(),
    city: String(data.get("city") || "").trim(),
    neighborhood: String(data.get("neighborhood") || "").trim(),
    about: String(data.get("about") || "").trim()
  };
  if (currentUser.role === "doula") {
    payload.services = data.getAll("services").map(String);
    payload.serviceMode = String(data.get("serviceMode") || "").trim();
    payload.experienceYears = String(data.get("experienceYears") || "");
    const price = String(data.get("price") || "").trim();
    payload.priceCents = price ? Math.round(Number(price) * 100) : null;
    payload.paymentUrl = String(data.get("paymentUrl") || "").trim();
    payload.published = data.get("published") === "on";
  } else {
    payload.pregnancyWeeks = String(data.get("pregnancyWeeks") || "");
    payload.dueDate = String(data.get("dueDate") || "");
    payload.preferences = String(data.get("preferences") || "").trim();
    payload.directoryOptIn = data.get("directoryOptIn") === "on";
    payload.contactSharingOptIn = data.get("contactSharingOptIn") === "on";
  }
  try {
    const result = await api("/api/profile", { method: "PUT", body: JSON.stringify(payload) });
    profileView(result.profile);
    showToast("Perfil salvo com sucesso.");
    if (currentUser.role === "doula") await renderDoulas();
  } catch (error) {
    showError(dialogContent, error.message);
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  renderDoulas();
});
serviceFilter.addEventListener("change", renderDoulas);
sortFilter.addEventListener("change", renderDoulas);
grid.addEventListener("click", async (event) => {
  const profileButton = event.target.closest("[data-profile]");
  const favoriteButton = event.target.closest("[data-favorite]");
  const clearButton = event.target.closest("[data-clear-search]");
  const retryButton = event.target.closest("[data-retry]");

  if (profileButton) {
    try {
      const { doula } = await api(`/api/doulas/${encodeURIComponent(profileButton.dataset.profile)}`);
      showDoulaProfile(doula);
    } catch (error) {
      showToast(error.message);
    }
  }
  if (favoriteButton) {
    const favorites = getFavorites();
    const id = favoriteButton.dataset.favorite;
    const updated = favorites.includes(id) ? favorites.filter((favorite) => favorite !== id) : [...favorites, id];
    try {
      localStorage.setItem(favoritesStorageKey, JSON.stringify(updated));
      await renderDoulas();
      showToast(updated.includes(id) ? "Doula adicionada aos seus favoritos neste navegador." : "Doula removida dos favoritos.");
    } catch {
      showToast("Não foi possível atualizar os favoritos neste navegador.");
    }
  }
  if (clearButton) {
    locationFilter.value = "";
    serviceFilter.value = "";
    await renderDoulas();
  }
  if (retryButton) await renderDoulas();
});

document.querySelector("#create-profile-button").addEventListener("click", () => {
  if (currentUser) document.querySelector("#my-profile-button").click();
  else renderAuthForm();
});
document.querySelector("#my-profile-button").addEventListener("click", async () => {
  if (!currentUser) return renderAuthForm("login");
  try {
    const { profile } = await api("/api/me");
    if (!profile || profile.name === "Perfil novo") profileForm(profile);
    else profileView(profile);
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#messages-button").addEventListener("click", () => renderMessages());
document.querySelector("#billing-button").addEventListener("click", () => renderBilling());
document.querySelector("#contacts-button").addEventListener("click", () => renderContacts());
document.querySelector("#admin-payments-button").addEventListener("click", () => renderAdminPayments());

dialog.addEventListener("click", async (event) => {
  if (event.target === dialog) closeDialog();
  const target = event.target.closest("button");
  if (!target) return;
  if (target.matches("[data-close-dialog]")) closeDialog();
  if (target.matches("[data-auth-mode]")) renderAuthForm(target.dataset.authMode);
  if (target.matches("[data-role]")) {
    dialogContent.querySelectorAll("[data-role]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button === target));
    });
    dialogContent.querySelector('[name="role"]').value = target.dataset.role;
  }
  if (target.matches("[data-edit-profile]")) {
    try {
      const { profile } = await api("/api/me");
      profileForm(profile);
    } catch (error) {
      showToast(error.message);
    }
  }
  if (target.matches("[data-logout]")) {
    try {
      await api("/api/auth/logout", { method: "POST" });
      currentUser = null;
      updateHeader();
      closeDialog();
      showToast("Você saiu da sua conta.");
    } catch (error) {
      showToast(error.message);
    }
  }
  if (target.matches("[data-delete-account]")) {
    if (!window.confirm("Apagar sua conta, perfil, conversas e mensagens permanentemente? Esta ação não pode ser desfeita.")) return;
    try {
      await api("/api/account", { method: "DELETE" });
      currentUser = null;
      updateHeader();
      closeDialog();
      showToast("Conta e dados apagados.");
      await renderDoulas();
    } catch (error) {
      showToast(error.message);
    }
  }
  if (target.matches("[data-contact]")) await startConversationForm(target.dataset.contact);
  if (target.matches("[data-conversation]")) await renderMessages(target.dataset.conversation);
  if (target.matches("[data-back-messages]")) await renderMessages();
  if (target.matches("[data-billing]")) await renderBilling();
  if (target.matches("[data-open-contacts]")) await renderContacts();
  if (target.matches("[data-admin-payments]")) await renderAdminPayments();
  if (target.matches("[data-review]")) {
    const submission = target.closest("[data-submission]");
    const id = target.dataset.id;
    const note = submission.querySelector('[name="reviewNote"]').value.trim();
    if (target.dataset.review === "rejected" && !note) {
      showError(submission, "Informe o motivo da rejeição.");
      return;
    }
    try {
      await api(`/api/admin/payments/${encodeURIComponent(id)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision: target.dataset.review, note })
      });
      showToast(target.dataset.review === "approved" ? "Pagamento confirmado; acesso liberado por 30 dias." : "Comprovante rejeitado; informe o motivo à doula.");
      await renderAdminPayments();
    } catch (error) {
      showToast(error.message);
    }
  }
});

dialog.addEventListener("change", (event) => {
  if (event.target.name === "directoryOptIn") {
    const emailOptIn = dialogContent.querySelector('[name="contactSharingOptIn"]');
    emailOptIn.disabled = !event.target.checked;
    if (!event.target.checked) emailOptIn.checked = false;
  }
});

dialog.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "auth-form") {
    event.preventDefault();
    await onAuthSubmit(form);
  }
  if (form.id === "profile-form") {
    event.preventDefault();
    await onProfileSubmit(form);
  }
  if (form.id === "contact-form") {
    event.preventDefault();
    try {
      const result = await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ doulaId: form.dataset.doula, message: new FormData(form).get("message") })
      });
      await renderMessages(result.conversationId);
      showToast("Mensagem enviada.");
    } catch (error) {
      showError(dialogContent, error.message);
    }
  }
  if (form.id === "message-form") {
    event.preventDefault();
    try {
      await api(`/api/conversations/${encodeURIComponent(form.dataset.conversation)}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: new FormData(form).get("message") })
      });
      await renderMessages(form.dataset.conversation);
      showToast("Mensagem enviada.");
    } catch (error) {
      showError(dialogContent, error.message);
    }
  }
  if (form.id === "billing-form") {
    event.preventDefault();
    const file = new FormData(form).get("proof");
    if (!(file instanceof File) || file.size === 0) {
      showError(dialogContent, "Selecione uma imagem do comprovante.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showError(dialogContent, "A imagem do comprovante deve ter até 5 MB.");
      return;
    }
    try {
      await api("/api/billing/proof", { method: "POST", body: new FormData(form) });
      showToast("Comprovante enviado. O acesso será liberado após a conferência do pagamento.");
      await renderBilling();
    } catch (error) {
      showError(dialogContent, error.message);
    }
  }
  if (form.id === "contacts-search") {
    event.preventDefault();
    await renderContacts(String(new FormData(form).get("city") || "").trim());
  }
});

const menuButton = document.querySelector("#menu-button");
menuButton.addEventListener("click", () => {
  const navigation = document.querySelector(".main-nav");
  const isExpanded = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!isExpanded));
  navigation.classList.toggle("is-open", !isExpanded);
});
document.querySelectorAll(".main-nav a").forEach((link) => link.addEventListener("click", () => {
  document.querySelector(".main-nav").classList.remove("is-open");
  menuButton.setAttribute("aria-expanded", "false");
}));

async function initialize() {
  await refreshCurrentUser();
  await renderDoulas();
}

initialize();
