module.exports = (sequelize, DataTypes) => {
  const LeaveRequest = sequelize.define(
    'LeaveRequest',
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
      leave_type: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      leave_type_id: DataTypes.UUID,
      from_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      to_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      days_count: DataTypes.DECIMAL(4, 1),
      is_half_day: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      half_day_period: {
        type: DataTypes.ENUM('morning', 'afternoon'),
        allowNull: true,
      },
      reason: DataTypes.TEXT,
      status: {
        type: DataTypes.ENUM(
          'pending',
          'manager_approved',
          'approved',
          'rejected',
          'cancelled',
          'cancellation_pending'
        ),
        defaultValue: 'pending',
      },
      approval_level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
      },
      manager_approved_by: DataTypes.UUID,
      manager_approved_at: DataTypes.DATE,
      final_approved_by: DataTypes.UUID,
      final_approved_at: DataTypes.DATE,
      approval_notes: DataTypes.TEXT,
      approved_by: DataTypes.UUID,
      approved_at: DataTypes.DATE,
      rejection_reason: DataTypes.TEXT,
      document_url: DataTypes.STRING,
      cancellation_reason: DataTypes.TEXT,
      cancellation_requested_by: DataTypes.UUID,
      cancellation_requested_at: DataTypes.DATE,
      cancellation_approved_by: DataTypes.UUID,
      cancellation_approved_at: DataTypes.DATE,
      policy_snapshot: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      validation_snapshot: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      payroll_locked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      payroll_period: DataTypes.STRING,
    },
    {
      tableName: 'leave_requests',
      paranoid: true,
      underscored: true,
    }
  );

  LeaveRequest.associate = (models) => {
    LeaveRequest.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'approved_by', as: 'approver' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'manager_approved_by', as: 'managerApprover' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'final_approved_by', as: 'finalApprover' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'cancellation_requested_by', as: 'cancellationRequester' });
    LeaveRequest.belongsTo(models.Employee, { foreignKey: 'cancellation_approved_by', as: 'cancellationApprover' });
    LeaveRequest.belongsTo(models.LeaveType, { foreignKey: 'leave_type_id', as: 'leaveTypeRecord' });
    LeaveRequest.hasMany(models.LeaveBalanceLedger, { foreignKey: 'request_id', as: 'ledgerEntries' });
  };

  return LeaveRequest;
};
