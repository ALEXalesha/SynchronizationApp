using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;

namespace SyncGlass.Wpf;

public sealed class InverseBoolVisibility : IValueConverter
{
    public object Convert(object value, Type t, object p, CultureInfo c) => value is true ? Visibility.Collapsed : Visibility.Visible;
    public object ConvertBack(object value, Type t, object p, CultureInfo c) => Binding.DoNothing;
}

public sealed class NullCollapsed : IValueConverter
{
    public object Convert(object? value, Type t, object p, CultureInfo c) => value == null ? Visibility.Collapsed : Visibility.Visible;
    public object ConvertBack(object value, Type t, object p, CultureInfo c) => Binding.DoNothing;
}

// Путь в заголовке панели: виден конец пути - в Electron так делал direction: rtl.
public sealed class TailTrim : IValueConverter
{
    private const int Max = 42;
    public object Convert(object? value, Type t, object p, CultureInfo c)
        => value is string s && s.Length > Max ? "…" + s[^(Max - 1)..] : value ?? "";
    public object ConvertBack(object value, Type t, object p, CultureInfo c) => Binding.DoNothing;
}

public sealed class DirectionIs : IValueConverter
{
    public object Convert(object value, Type t, object p, CultureInfo c) => Equals(value, p);
    public object ConvertBack(object value, Type t, object p, CultureInfo c) => Binding.DoNothing;
}

// Отступ строки по глубине: 12 + глубина × 18 слева (padding-left в renderer.js).
public sealed class LeftPad : IValueConverter
{
    public static readonly LeftPad Instance = new();
    public object Convert(object value, Type t, object p, CultureInfo c) => new Thickness(value is double d ? d - 4 : 8, 6, 0, 6);
    public object ConvertBack(object value, Type t, object p, CultureInfo c) => Binding.DoNothing;
}

// Крутилка на строке папки, пока грузятся её дети (caret.mini-spin в styles.css).
public sealed class Spinner : Canvas
{
    public Spinner()
    {
        Width = 11;
        Height = 11;
        var ring = new Ellipse { Width = 11, Height = 11, Stroke = new SolidColorBrush(Color.FromArgb(0x33, 255, 255, 255)), StrokeThickness = 2 };
        var arc = new Path
        {
            Data = Geometry.Parse("M5.5,0.5 A5,5 0 0 1 10.5,5.5"),
            Stroke = (Brush)Application.Current.FindResource("Accent"),
            StrokeThickness = 2,
        };
        Children.Add(ring);
        Children.Add(arc);
        var rotate = new RotateTransform(0, 5.5, 5.5);
        RenderTransform = rotate;
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible) rotate.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(0.7)) { RepeatBehavior = RepeatBehavior.Forever });
            else rotate.BeginAnimation(RotateTransform.AngleProperty, null);
        };
        VerticalAlignment = VerticalAlignment.Center;
        HorizontalAlignment = HorizontalAlignment.Center;
    }
}

// Бегущая полоска активности, когда объём заранее неизвестен (sb-bar, indeterminate).
// Анимация идёт только пока полоска видна: лишние кадры в фоне не нужны.
public sealed class RunningBar : Grid
{
    public RunningBar()
    {
        ClipToBounds = true;
        Background = new SolidColorBrush(Color.FromArgb(0x0F, 255, 255, 255));
        var bar = new Border { Background = (Brush)Application.Current.FindResource("Accent"), HorizontalAlignment = HorizontalAlignment.Left, CornerRadius = new CornerRadius(1) };
        Children.Add(bar);
        var shift = new TranslateTransform();
        bar.RenderTransform = shift;
        void Run()
        {
            if (!IsVisible || ActualWidth <= 0)
            {
                shift.BeginAnimation(TranslateTransform.XProperty, null);
                return;
            }
            bar.Width = ActualWidth * 0.35;
            shift.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(-bar.Width, ActualWidth, TimeSpan.FromSeconds(1.1))
            {
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
            });
        }
        IsVisibleChanged += (_, _) => Run();
        SizeChanged += (_, _) => Run();
    }
}
