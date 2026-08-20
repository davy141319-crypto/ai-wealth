import { Card, Col, Row, Statistic } from 'antd';
import { DashboardChart } from '@/components/DashboardChart';

/**
 * P0 dashboard placeholder. Metrics show "—" because no business data exists yet;
 * the chart is real (ECharts) only to validate the ECharts wiring end-to-end.
 */
export function Dashboard() {
  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="Total Users" value="—" />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="Total Assets (USDT)" value="—" />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="Active Products" value="—" />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title="Pending Withdrawals" value="—" />
          </Card>
        </Col>
      </Row>
      <Card title="Overview" style={{ marginTop: 16 }}>
        <DashboardChart />
      </Card>
    </>
  );
}
