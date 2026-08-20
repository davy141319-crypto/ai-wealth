import ReactECharts from 'echarts-for-react';

const option = {
  tooltip: { trigger: 'axis' as const },
  xAxis: {
    type: 'category' as const,
    data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  },
  yAxis: { type: 'value' as const },
  series: [
    {
      data: [120, 200, 150, 80, 170],
      type: 'bar' as const,
    },
  ],
};

/** Real ECharts wiring so the chart stack is verified end-to-end in P0. */
export function DashboardChart() {
  return <ReactECharts option={option} style={{ height: 320 }} />;
}
