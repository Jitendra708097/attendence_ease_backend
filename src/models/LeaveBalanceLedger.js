module.exports = (sequelize, DataTypes) => {
  const LeaveBalanceLedger = sequelize.define(
    'LeaveBalanceLedger',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      leave_type_id: DataTypes.UUID,
      leave_type: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      transaction_type: {
        type: DataTypes.ENUM(
          'opening',
          'entitlement',
          'accrual',
          'debit',
          'credit',
          'adjustment',
          'refund',
          'expiry',
          'encashment'
        ),
        allowNull: false,
      },
      days: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
      },
      balance_after: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
      },
      request_id: DataTypes.UUID,
      actor_id: DataTypes.UUID,
      reason: DataTypes.TEXT,
      effective_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'leave_balance_ledger',
      underscored: true,
      indexes: [
        { fields: ['org_id', 'emp_id', 'leave_type'] },
        { fields: ['org_id', 'request_id'] },
        { fields: ['effective_date'] },
      ],
    }
  );

  LeaveBalanceLedger.associate = (models) => {
    LeaveBalanceLedger.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeaveBalanceLedger.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
    LeaveBalanceLedger.belongsTo(models.Employee, { foreignKey: 'actor_id', as: 'actor' });
    LeaveBalanceLedger.belongsTo(models.LeaveType, { foreignKey: 'leave_type_id', as: 'leaveTypeRecord' });
    LeaveBalanceLedger.belongsTo(models.LeaveRequest, { foreignKey: 'request_id', as: 'request' });
  };

  return LeaveBalanceLedger;
};
