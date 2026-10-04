Feature: Support dashboard
  The numbers change on every load, so assertions describe their shape, not their values.

  Scenario: KPIs and recent tickets are visible
    Given I am on the dashboard
    Then I see the open tickets KPI with a number
    And I see customer satisfaction as a percentage
    And the recent tickets table lists at least one ticket
