using System;
using System.Drawing;
using System.Windows.Forms;

namespace BaboCoding
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly Color Canvas = Color.FromArgb(8, 15, 31);
        private static readonly Color Sidebar = Color.FromArgb(12, 23, 45);
        private static readonly Color Surface = Color.FromArgb(17, 31, 57);
        private static readonly Color SurfaceRaised = Color.FromArgb(23, 42, 74);
        private static readonly Color Accent = Color.FromArgb(44, 128, 246);
        private static readonly Color AccentGreen = Color.FromArgb(73, 201, 164);
        private static readonly Color TextPrimary = Color.FromArgb(231, 239, 251);
        private static readonly Color TextSecondary = Color.FromArgb(142, 160, 188);

        private readonly RichTextBox activityLog;

        public MainForm()
        {
            Text = "BABO CODING - MGU Store companion";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1000, 720);
            Size = new Size(1220, 820);
            BackColor = Canvas;
            ForeColor = TextPrimary;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            activityLog = new RichTextBox();
            BuildInterface();
            AddLog("BABO CODING started.");
            AddLog("Simulation only. No device, network, key file, or local package was accessed.");
        }

        private void BuildInterface()
        {
            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.Margin = new Padding(0);
            root.Padding = new Padding(0);
            root.ColumnCount = 1;
            root.RowCount = 2;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 84F));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.Controls.Add(BuildHeader(), 0, 0);

            TableLayoutPanel body = new TableLayoutPanel();
            body.Dock = DockStyle.Fill;
            body.Margin = new Padding(0);
            body.Padding = new Padding(0);
            body.ColumnCount = 2;
            body.RowCount = 1;
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 238F));
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            body.Controls.Add(BuildSidebar(), 0, 0);
            body.Controls.Add(BuildMainContent(), 1, 0);
            root.Controls.Add(body, 0, 1);
            Controls.Add(root);
        }

        private Control BuildHeader()
        {
            Panel header = new Panel();
            header.Dock = DockStyle.Fill;
            header.BackColor = Sidebar;
            header.Padding = new Padding(28, 14, 28, 14);

            Label brand = new Label();
            brand.Text = "BABO CODING";
            brand.Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold);
            brand.ForeColor = TextPrimary;
            brand.AutoSize = true;
            brand.Location = new Point(28, 12);

            Label product = new Label();
            product.Text = "MGU STORE COMPANION";
            product.Font = new Font("Segoe UI", 8.5F, FontStyle.Bold);
            product.ForeColor = TextSecondary;
            product.AutoSize = true;
            product.Location = new Point(30, 48);

            Label mode = new Label();
            mode.Text = "OFFLINE SIMULATION";
            mode.Font = new Font("Segoe UI", 8F, FontStyle.Bold);
            mode.ForeColor = AccentGreen;
            mode.BackColor = Color.FromArgb(21, 54, 59);
            mode.TextAlign = ContentAlignment.MiddleCenter;
            mode.Size = new Size(172, 32);
            mode.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            mode.Location = new Point(Width - 220, 25);

            header.Controls.Add(brand);
            header.Controls.Add(product);
            header.Controls.Add(mode);
            return header;
        }

        private Control BuildSidebar()
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = Sidebar;
            panel.Padding = new Padding(22, 24, 18, 18);

            Label section = CreateLabel("WORKSPACE", 8F, TextSecondary, true);
            section.Location = new Point(22, 28);
            section.AutoSize = true;

            Panel selection = new Panel();
            selection.BackColor = SurfaceRaised;
            selection.Location = new Point(16, 62);
            selection.Size = new Size(198, 54);
            selection.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            Panel marker = new Panel();
            marker.BackColor = Accent;
            marker.Size = new Size(3, 54);
            marker.Dock = DockStyle.Left;

            Label selectionText = CreateLabel("MGU Store", 10F, TextPrimary, true);
            selectionText.Location = new Point(20, 17);
            selectionText.AutoSize = true;
            selection.Controls.Add(marker);
            selection.Controls.Add(selectionText);

            Label deviceSection = CreateLabel("DEVICE PROFILE", 8F, TextSecondary, true);
            deviceSection.Location = new Point(22, 145);
            deviceSection.AutoSize = true;

            Label deviceName = CreateLabel("MGU head unit", 10F, TextPrimary, false);
            deviceName.Location = new Point(22, 177);
            deviceName.AutoSize = true;

            Label deviceNote = CreateLabel("Reference profile only", 8.5F, TextSecondary, false);
            deviceNote.Location = new Point(22, 202);
            deviceNote.AutoSize = true;

            Panel divider = new Panel();
            divider.BackColor = Color.FromArgb(37, 54, 80);
            divider.Location = new Point(22, 244);
            divider.Size = new Size(176, 1);
            divider.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            Label boundary = CreateLabel("This build demonstrates the installer layout. It does not connect to a car or change files.", 8.5F, TextSecondary, false);
            boundary.Location = new Point(22, 264);
            boundary.Size = new Size(174, 76);
            boundary.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            panel.Controls.Add(section);
            panel.Controls.Add(selection);
            panel.Controls.Add(deviceSection);
            panel.Controls.Add(deviceName);
            panel.Controls.Add(deviceNote);
            panel.Controls.Add(divider);
            panel.Controls.Add(boundary);
            return panel;
        }

        private Control BuildMainContent()
        {
            TableLayoutPanel content = new TableLayoutPanel();
            content.Dock = DockStyle.Fill;
            content.Padding = new Padding(26, 22, 26, 22);
            content.ColumnCount = 1;
            content.RowCount = 4;
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 72F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 260F));
            content.RowStyles.Add(new RowStyle(SizeType.Absolute, 151F));
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            content.Controls.Add(BuildPageTitle(), 0, 0);
            content.Controls.Add(BuildConfigurationCard(), 0, 1);
            content.Controls.Add(BuildActionsCard(), 0, 2);
            content.Controls.Add(BuildActivityCard(), 0, 3);
            return content;
        }

        private Control BuildPageTitle()
        {
            Panel titlePanel = new Panel();
            titlePanel.Dock = DockStyle.Fill;

            Label title = CreateLabel("Installer dashboard", 17F, TextPrimary, true);
            title.Location = new Point(0, 0);
            title.AutoSize = true;

            Label subtitle = CreateLabel("Configuration is display-only. No credentials or vehicle data are collected.", 9F, TextSecondary, false);
            subtitle.Location = new Point(1, 34);
            subtitle.AutoSize = true;

            titlePanel.Controls.Add(title);
            titlePanel.Controls.Add(subtitle);
            return titlePanel;
        }

        private Control BuildConfigurationCard()
        {
            Panel card = CreateCard();
            Label heading = CreateLabel("CONNECTION SETTINGS", 8F, TextSecondary, true);
            heading.Location = new Point(17, 14);
            heading.AutoSize = true;

            TableLayoutPanel fields = new TableLayoutPanel();
            fields.Dock = DockStyle.Bottom;
            fields.Height = 198;
            fields.Margin = new Padding(0);
            fields.Padding = new Padding(0);
            fields.ColumnCount = 2;
            fields.RowCount = 3;
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
            fields.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            fields.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            fields.RowStyles.Add(new RowStyle(SizeType.Percent, 33.34F));

            ComboBox target = new ComboBox();
            target.DropDownStyle = ComboBoxStyle.DropDownList;
            target.Items.Add("iDrive 7 (reference)");
            target.Items.Add("iDrive 8 (not tested on real cars)");
            target.SelectedIndex = 0;
            fields.Controls.Add(CreateField("TARGET FAMILY (DEMO)", target), 0, 0);

            TextBox iLevel = CreateTextBox();
            iLevel.Text = "Not detected in simulation";
            iLevel.ReadOnly = true;
            fields.Controls.Add(CreateField("I-LEVEL", iLevel), 1, 0);

            TextBox host = CreateTextBox();
            host.Text = "172.16.222.97";
            fields.Controls.Add(CreateField("MGU IP", host), 0, 1);

            TextBox port = CreateTextBox();
            port.Text = "22";
            fields.Controls.Add(CreateField("SSH PORT", port), 1, 1);

            TextBox identity = CreateTextBox();
            identity.Text = "Not read in simulation";
            identity.ReadOnly = true;
            Control identityField = CreateField("PRIVATE KEY", identity);
            fields.Controls.Add(identityField, 0, 2);
            fields.SetColumnSpan(identityField, 2);

            card.Controls.Add(heading);
            card.Controls.Add(fields);
            return card;
        }

        private Control BuildActionsCard()
        {
            Panel card = CreateCard();
            Label heading = CreateLabel("AVAILABLE DEMONSTRATIONS", 8F, TextSecondary, true);
            heading.Location = new Point(17, 14);
            heading.AutoSize = true;

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Bottom;
            buttons.Height = 84;
            buttons.Padding = new Padding(0, 16, 0, 0);
            buttons.WrapContents = true;

            Button connection = CreateActionButton("SIMULATE SSH CHECK", Accent, 205);
            connection.Click += delegate { AddLog(SimulationService.Describe(SimulationAction.ConnectionCheck)); };

            Button install = CreateActionButton("SIMULATE STORE INSTALL", Color.FromArgb(29, 100, 207), 220);
            install.Click += delegate { AddLog(SimulationService.Describe(SimulationAction.StoreInstall)); };

            Button usb = CreateActionButton("SIMULATE OFFLINE USB PREP", SurfaceRaised, 238);
            usb.Click += delegate { AddLog(SimulationService.Describe(SimulationAction.UsbPreparation)); };

            buttons.Controls.Add(connection);
            buttons.Controls.Add(install);
            buttons.Controls.Add(usb);
            card.Controls.Add(heading);
            card.Controls.Add(buttons);
            return card;
        }

        private Control BuildActivityCard()
        {
            Panel card = CreateCard();

            Label heading = CreateLabel("ACTIVITY LOG", 8F, TextSecondary, true);
            heading.Location = new Point(17, 14);
            heading.AutoSize = true;

            Button clear = new Button();
            clear.Text = "CLEAR";
            clear.Font = new Font("Segoe UI", 8F, FontStyle.Bold);
            clear.ForeColor = TextSecondary;
            clear.BackColor = SurfaceRaised;
            clear.FlatStyle = FlatStyle.Flat;
            clear.FlatAppearance.BorderSize = 0;
            clear.Size = new Size(74, 28);
            clear.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            clear.Location = new Point(card.Width - 100, 10);
            clear.Click += delegate
            {
                activityLog.Clear();
                AddLog("Local simulation log cleared.");
            };

            activityLog.Dock = DockStyle.Fill;
            activityLog.BackColor = Color.FromArgb(9, 18, 34);
            activityLog.ForeColor = Color.FromArgb(183, 205, 231);
            activityLog.Font = new Font("Consolas", 9F, FontStyle.Regular);
            activityLog.BorderStyle = BorderStyle.None;
            activityLog.ReadOnly = true;
            activityLog.DetectUrls = false;
            activityLog.Margin = new Padding(0);

            Panel logFrame = new Panel();
            logFrame.Dock = DockStyle.Fill;
            logFrame.Padding = new Padding(10);
            logFrame.BackColor = Color.FromArgb(9, 18, 34);
            logFrame.Controls.Add(activityLog);

            Panel logContainer = new Panel();
            logContainer.Dock = DockStyle.Bottom;
            logContainer.Height = 178;
            logContainer.Padding = new Padding(0, 36, 0, 0);
            logContainer.Controls.Add(logFrame);

            card.Controls.Add(heading);
            card.Controls.Add(clear);
            card.Controls.Add(logContainer);
            return card;
        }

        private Panel CreateCard()
        {
            Panel card = new Panel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0, 0, 0, 10);
            card.Padding = new Padding(16);
            card.BackColor = Surface;
            card.BorderStyle = BorderStyle.FixedSingle;
            return card;
        }

        private Control CreateField(string title, Control input)
        {
            Panel field = new Panel();
            field.Dock = DockStyle.Fill;
            field.Padding = new Padding(12, 5, 12, 4);

            Label caption = CreateLabel(title, 8F, TextSecondary, true);
            caption.Dock = DockStyle.Top;
            caption.Height = 20;

            input.Dock = DockStyle.Top;
            input.Margin = new Padding(0, 1, 0, 0);
            input.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            input.BackColor = Color.FromArgb(11, 23, 42);
            input.ForeColor = TextPrimary;
            input.Height = 31;
            if (input is TextBox)
            {
                ((TextBox)input).BorderStyle = BorderStyle.FixedSingle;
            }

            field.Controls.Add(input);
            field.Controls.Add(caption);
            return field;
        }

        private TextBox CreateTextBox()
        {
            TextBox textBox = new TextBox();
            textBox.BorderStyle = BorderStyle.FixedSingle;
            textBox.BackColor = Color.FromArgb(11, 23, 42);
            textBox.ForeColor = TextPrimary;
            return textBox;
        }

        private Button CreateActionButton(string text, Color color, int width)
        {
            Button button = new Button();
            button.Text = text;
            button.Size = new Size(width, 42);
            button.Margin = new Padding(0, 0, 10, 8);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = color;
            button.ForeColor = TextPrimary;
            button.Font = new Font("Segoe UI", 8F, FontStyle.Bold);
            button.Cursor = Cursors.Hand;
            return button;
        }

        private static Label CreateLabel(string text, float size, Color color, bool bold)
        {
            Label label = new Label();
            label.Text = text;
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.Font = new Font(bold ? "Segoe UI Semibold" : "Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
            return label;
        }

        private void AddLog(string message)
        {
            activityLog.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine);
            activityLog.SelectionStart = activityLog.TextLength;
            activityLog.ScrollToCaret();
        }
    }
}
