using System.Diagnostics;
using System.Drawing;
using System.Text;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Forms;

namespace PromoIaulin;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var singleInstance = new Mutex(true, @"Local\PromoIaulinDesktop", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show("O Promo Iaulin já está aberto. Procure o ícone perto do relógio do Windows.",
                "Promo Iaulin", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ControlCenter());
    }
}

internal sealed class ControlCenter : Form
{
    private const string PanelUrl = "http://127.0.0.1:3030/";
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 1200 };
    private readonly NotifyIcon tray;
    private readonly Label status;
    private readonly Label hint;
    private readonly ProgressBar progress;
    private readonly Button panelButton;
    private readonly Button whatsappButton;
    private readonly Button siteButton;
    private readonly Button retryButton;
    private Process? worker;
    private bool ready;
    private bool opening = true;
    private bool checking;
    private bool quitting;
    private int attempts;
    private readonly string userFolder;

    public ControlCenter()
    {
        Text = "Promo Iaulin | Meu WhatsApp";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(580, 495);
        MinimumSize = new Size(580, 495);
        MaximumSize = new Size(580, 495);
        BackColor = Color.FromArgb(248, 247, 244);
        Font = new Font("Segoe UI", 10);
        MaximizeBox = false;
        var iconFile = Path.Combine(AppContext.BaseDirectory, "iaulin.ico");
        if (File.Exists(iconFile)) Icon = new Icon(iconFile);

        userFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Promo Iaulin");
        Directory.CreateDirectory(userFolder);
        tray = new NotifyIcon
        {
            Icon = Icon ?? SystemIcons.Application,
            Text = "Promo Iaulin",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip()
        };
        tray.ContextMenuStrip.Items.Add("Abrir o painel", null, (_, _) => OpenPanel(false));
        tray.ContextMenuStrip.Items.Add("Mostrar janela", null, (_, _) => ShowWindow());
        tray.ContextMenuStrip.Items.Add(new ToolStripSeparator());
        tray.ContextMenuStrip.Items.Add("Encerrar Promo Iaulin", null, (_, _) => ExitApp());
        tray.DoubleClick += (_, _) => ShowWindow();

        var banner = new Panel { Left = 0, Top = 0, Width = 580, Height = 118, BackColor = Color.FromArgb(51, 38, 59) };
        var logo = new Label
        {
            Text = "P↗", Left = 28, Top = 22, Width = 70, Height = 68,
            ForeColor = Color.FromArgb(215, 227, 182), BackColor = banner.BackColor,
            Font = new Font("Segoe UI", 26, FontStyle.Bold)
        };
        var title = new Label
        {
            Text = "Promo Iaulin", Left = 112, Top = 22, Width = 410, Height = 43,
            Font = new Font("Segoe UI", 22, FontStyle.Bold), ForeColor = Color.White, BackColor = banner.BackColor
        };
        var subtitle = new Label
        {
            Text = "Seu espaço de ofertas e WhatsApp", Left = 114, Top = 71, Width = 400, Height = 26,
            ForeColor = Color.FromArgb(225, 221, 231), BackColor = banner.BackColor
        };
        banner.Controls.AddRange([logo, title, subtitle]);
        Controls.Add(banner);

        status = new Label
        {
            Text = "Preparando seu aplicativo…", Left = 38, Top = 154, Width = 500, Height = 36,
            ForeColor = Color.FromArgb(51, 38, 59), Font = new Font("Segoe UI", 15, FontStyle.Bold)
        };
        hint = new Label
        {
            Text = "O aplicativo prepara tudo automaticamente. Nenhum comando é necessário.",
            Left = 39, Top = 200, Width = 504, Height = 60, ForeColor = Color.FromArgb(95, 90, 102)
        };
        progress = new ProgressBar { Left = 39, Top = 265, Width = 497, Height = 8, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 24 };
        panelButton = ActionButton("Abrir meu painel", 39, 303, 196, Color.FromArgb(51, 38, 59), Color.White);
        whatsappButton = ActionButton("Conectar WhatsApp", 248, 303, 224, Color.FromArgb(215, 227, 182), Color.FromArgb(51, 38, 59));
        siteButton = ActionButton("Vincular minha conta online", 39, 357, 433, Color.White, Color.FromArgb(51, 38, 59));
        retryButton = ActionButton("Tentar novamente", 39, 303, 210, Color.FromArgb(51, 38, 59), Color.White);
        panelButton.Enabled = false;
        whatsappButton.Enabled = false;
        siteButton.Enabled = false;
        retryButton.Visible = false;
        panelButton.Click += (_, _) => OpenPanel(false);
        whatsappButton.Click += (_, _) => OpenPanel(true);
        siteButton.Click += async (_, _) => await LinkSiteAsync();
        retryButton.Click += (_, _) => StartWorker();
        Controls.AddRange([status, hint, progress, panelButton, whatsappButton, siteButton, retryButton]);

        var footer = new Label
        {
            Text = "Seus dados e a sessão ficam no seu computador. Fechar esta janela minimiza o app.",
            Left = 39, Top = 422, Width = 510, Height = 24,
            Font = new Font("Segoe UI", 8), ForeColor = Color.FromArgb(110, 104, 116)
        };
        Controls.Add(footer);

        timer.Tick += async (_, _) => await CheckWorkerAsync();
        Shown += (_, _) => StartWorker();
        FormClosing += (_, e) =>
        {
            if (quitting) return;
            e.Cancel = true;
            Hide();
            tray.BalloonTipTitle = "Promo Iaulin continua ligado";
            tray.BalloonTipText = "O bot continua funcionando. Para encerrá-lo, use o ícone próximo ao relógio.";
            tray.ShowBalloonTip(3000);
        };
    }

    private static Button ActionButton(string text, int x, int y, int width, Color background, Color foreground)
        => new()
        {
            Text = text, Left = x, Top = y, Width = width, Height = 45,
            FlatStyle = FlatStyle.Flat, BackColor = background, ForeColor = foreground,
            Font = new Font("Segoe UI", 10, FontStyle.Bold), Cursor = Cursors.Hand
        };

    private void StartWorker()
    {
        retryButton.Visible = false;
        panelButton.Visible = true;
        whatsappButton.Visible = true;
        panelButton.Enabled = false;
        whatsappButton.Enabled = false;
        siteButton.Enabled = false;
        siteButton.Visible = true;
        status.Text = "Preparando seu aplicativo…";
        hint.Text = "Abriremos o painel automaticamente quando tudo estiver pronto.";
        progress.Style = ProgressBarStyle.Marquee;
        progress.MarqueeAnimationSpeed = 24;
        ready = false;
        attempts = 0;
        opening = true;

        var root = AppContext.BaseDirectory;
        var node = Path.Combine(root, "runtime", "node.exe");
        var entry = Path.Combine(root, "dist", "worker", "apps", "worker", "src", "index.js");
        var web = Path.Combine(root, "apps", "web", "dist");
        if (!File.Exists(node) || !File.Exists(entry) || !File.Exists(Path.Combine(web, "index.html")))
        {
            Fail("Instalação incompleta.", "Reinstale o Promo Iaulin pelo instalador oficial. Seus dados serão preservados.");
            return;
        }

        try
        {
            if (worker is { HasExited: false }) return;
            worker?.Dispose();
            var start = new ProcessStartInfo(node)
            {
                WorkingDirectory = userFolder,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.ArgumentList.Add(entry);
            start.Environment["PROMOBRIDGE_WEB_DIR"] = web;
            start.Environment["PROMOBRIDGE_PORT"] = "3030";
            worker = Process.Start(start) ?? throw new InvalidOperationException("O Windows não conseguiu iniciar o serviço.");
            timer.Start();
        }
        catch (Exception error)
        {
            Fail("Não foi possível abrir.", error.Message);
        }
    }

    private async Task CheckWorkerAsync()
    {
        if (checking || ready) return;
        checking = true;
        try
        {
            attempts++;
            if (worker is null || worker.HasExited)
            {
                Fail("O serviço não iniciou.", "Verifique se a porta 3030 está livre e se o antivírus não bloqueou o aplicativo.");
                return;
            }
            using var response = await client.GetAsync(PanelUrl + "api/v1/health");
            if (!response.IsSuccessStatusCode) return;
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (!json.RootElement.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True ||
                !json.RootElement.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.String) return;

            ready = true;
            timer.Stop();
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = 100;
            status.Text = "Tudo pronto para conectar! ✓";
            hint.Text = "Clique em Conectar WhatsApp e leia o QR Code com seu celular. O Promo Iaulin permanece ativo próximo ao relógio.";
            panelButton.Enabled = true;
            whatsappButton.Enabled = true;
            siteButton.Enabled = true;
            if (opening) OpenPanel(true);
            opening = false;
        }
        catch (HttpRequestException) { }
        catch (TaskCanceledException) { }
        catch (JsonException) { }
        catch (Exception error)
        {
            Fail("Não foi possível verificar o aplicativo.", error.Message);
        }
        finally
        {
            checking = false;
        }
        if (!ready && attempts >= 40)
            Fail("O aplicativo não respondeu.", "O serviço está demorando além do esperado. Confira se a porta 3030 está disponível.");
    }

    private void Fail(string title, string details)
    {
        timer.Stop();
        status.Text = title;
        hint.Text = details.Length > 170 ? details[..170] : details;
        progress.Style = ProgressBarStyle.Continuous;
        progress.Value = 0;
        panelButton.Visible = false;
        whatsappButton.Visible = false;
        retryButton.Visible = true;
        siteButton.Visible = false;
    }

    private async Task LinkSiteAsync()
    {
        if (!ready || !siteButton.Enabled) return;
        siteButton.Enabled = false;
        status.Text = "Preparando conexão segura com o site…";
        hint.Text = "O Promo Iaulin está iniciando um acesso temporário seguro ao seu computador.";
        try
        {
            using var network = new HttpClient { Timeout = TimeSpan.FromSeconds(115) };
            using var sessionResponse = await network.GetAsync(PanelUrl + "api/v1/session");
            sessionResponse.EnsureSuccessStatusCode();
            using var session = JsonDocument.Parse(await sessionResponse.Content.ReadAsStringAsync());
            var csrf = session.RootElement.GetProperty("csrfToken").GetString();
            if (string.IsNullOrWhiteSpace(csrf)) throw new InvalidOperationException("A sessão local não respondeu corretamente.");

            using var request = new HttpRequestMessage(HttpMethod.Post, PanelUrl + "api/v1/remote/start");
            request.Headers.TryAddWithoutValidation("Origin", "http://127.0.0.1:3030");
            request.Headers.TryAddWithoutValidation("X-CSRF-Token", csrf);
            request.Content = new StringContent("{\"mode\":\"temporary\"}", Encoding.UTF8, "application/json");
            using var response = await network.SendAsync(request);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Não conseguimos ativar o acesso remoto. Verifique a internet e tente novamente.");
            using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (!result.RootElement.TryGetProperty("pairing", out var pairing) || !pairing.TryGetProperty("url", out var urlElement))
                throw new InvalidOperationException("O link temporário não ficou pronto. Tente novamente.");
            var pairingUrl = urlElement.GetString();
            if (!Uri.TryCreate(pairingUrl, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps || !url.Fragment.StartsWith("#pair=", StringComparison.Ordinal))
                throw new InvalidOperationException("O link de conexão é inválido. Gere outro.");
            var siteLink = "https://promo-iaulin.vercel.app/#worker-pair=" + Uri.EscapeDataString(pairingUrl);
            Process.Start(new ProcessStartInfo(siteLink) { UseShellExecute = true });
            status.Text = "Confirme o vínculo no site ✓";
            hint.Text = "Entre na sua conta, confira a solicitação e clique em Confirmar. Não é necessário copiar códigos ou usar Render.";
        }
        catch (Exception error)
        {
            status.Text = "Seu WhatsApp local continua funcionando";
            hint.Text = "O vínculo com o site não foi concluído. Confira a internet e tente novamente.";
            MessageBox.Show(error.Message, "Não foi possível vincular ao site", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally { siteButton.Enabled = ready; }
    }

    private void OpenPanel(bool whatsApp)
    {
        if (!ready) return;
        var url = PanelUrl + (whatsApp ? "#sources" : "");
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(error.Message, "Não foi possível abrir o navegador", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApp()
    {
        quitting = true;
        timer.Stop();
        tray.Visible = false;
        tray.Dispose();
        try { if (worker is { HasExited: false }) worker.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        worker?.Dispose();
        client.Dispose();
        Close();
    }
}
